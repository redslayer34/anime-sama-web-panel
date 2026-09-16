"""Tests du relais de flux : filtre anti-rebond, réécriture HLS, requêtes Range.

La partie « bout en bout » neutralise volontairement `stream_target` : le faux
hébergeur écoute sur une adresse privée, que le filtre de production refuse — à
juste titre. Le filtre lui-même est testé juste au-dessus, sur huit cas.

Prérequis : tests/mocks/video_host.py doit tourner (voir tests/run.py).
"""
import importlib.util, os, pathlib, threading, urllib.request, urllib.parse, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("serve", ROOT / "serve.py")
serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)

bad = 0
def ck(label, ok, extra=""):
    global bad
    if not ok: bad += 1
    print(f"  {'ok ' if ok else 'KO '} {label}" + (f" :: {extra}" if extra else ""))

print("=== Filtre anti-rebond (SSRF) ===")
cases = [
    ("http://127.0.0.1:5000/api/x", False, "backend interne"),
    ("http://[::1]/x",              False, "loopback IPv6"),
    ("http://10.1.2.3/x",           False, "réseau privé"),
    ("http://169.254.169.254/",     False, "métadonnées cloud"),
    ("file:///etc/passwd",          False, "schéma fichier"),
    ("javascript:alert(1)",         False, "schéma javascript"),
    ("",                            False, "paramètre vide"),
    ("http://93.184.216.34/v.m3u8", True,  "adresse publique"),
]
for url, expected, label in cases:
    target, refusal = serve.stream_target(url)
    ok = (target is not None) == expected
    ck(f"{label}", ok, refusal or "accepté")

print("\n=== Réécriture de playlist HLS ===")
playlist = '''#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.key"
#EXTINF:4.0,
seg/0.ts
#EXTINF:4.0,
/abs/seg/1.ts
#EXTINF:4.0,
https://cdn.autre.test/seg/2.ts
#EXT-X-ENDLIST
'''
out = serve.rewrite_playlist(playlist, "https://host.test/v/index.m3u8")
plain = urllib.parse.unquote(out)
ck("segment relatif résolu contre l'URL de la playlist",
   "https://host.test/v/seg/0.ts" in plain)
ck("chemin absolu résolu à la racine de l'hôte", "https://host.test/abs/seg/1.ts" in plain)
ck("hôte tiers conservé tel quel", "https://cdn.autre.test/seg/2.ts" in plain)
ck("clé de chiffrement relayée", 'URI="/stream?u=' in out)
ck("directives conservées", "#EXT-X-ENDLIST" in out and "#EXTINF:4.0," in out)
ck("aucune URL laissée en direct", all(
    l.startswith("#") or l.startswith("/stream?u=") or not l.strip()
    for l in out.splitlines()))

print("\n=== Bout en bout via HTTP ===")
serve.stream_target = lambda url: (url, None) if url else (None, "paramètre « u » manquant")
serve.PanelHandler.api_base = None
serve.PanelHandler.quiet = True
server = serve.ThreadingHTTPServer(("127.0.0.1", 8601), serve.PanelHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
time.sleep(0.4)

HOST = os.environ.get("VIDEO_HOST", "http://127.0.0.1:9100")
def relay(path, headers=None):
    url = "http://127.0.0.1:8601/stream?u=" + urllib.parse.quote(HOST + path, safe="")
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=15)

try:
    r = relay("/v/index.m3u8")
    text = r.read().decode()
    ck("playlist relayée malgré l'anti-hotlink", r.status == 200 and text.startswith("#EXTM3U"))
    ck("segments réécrits vers le relais", text.count("/stream?u=") == 4, f"{text.count('/stream?u=')} URL")
    ck("type de contenu HLS", "mpegurl" in r.headers.get("Content-Type", ""))

    seg = urllib.parse.unquote([l for l in text.splitlines() if l.startswith("/stream")][1].split("u=")[1])
    r2 = urllib.request.urlopen("http://127.0.0.1:8601/stream?u=" + urllib.parse.quote(seg, safe=""), timeout=15)
    ck("segment servi à travers le relais", r2.status == 200 and len(r2.read()) == 1880)

    r3 = relay("/media/film.mp4")
    ck("binaire transmis intégralement", len(r3.read()) == 200000)
    ck("Accept-Ranges conservé", r3.headers.get("Accept-Ranges") == "bytes")

    r4 = relay("/media/film.mp4", {"Range": "bytes=100-199"})
    body = r4.read()
    ck("requête Range relayée (206)", r4.status == 206, str(r4.status))
    ck("Content-Range conservé", r4.headers.get("Content-Range") == "bytes 100-199/200000",
       str(r4.headers.get("Content-Range")))
    ck("taille du morceau correcte", len(body) == 100, str(len(body)))

    master = relay("/v/master.m3u8").read().decode()
    ck("playlist maître réécrite", master.count("/stream?u=") == 2)
except Exception as err:
    ck("bout en bout", False, repr(err))

print()
print("RELAIS : TOUT EST VERT" if not bad else f"{bad} ÉCHEC(S)")
sys.exit(1 if bad else 0)
