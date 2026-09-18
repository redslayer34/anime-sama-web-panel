#!/usr/bin/env python3
"""
Vérification « ce flux répond-il ? » : la réécriture doit être invisible.

La fonction d'origine tentait la requête sans Referer, puis, en cas d'échec,
la même avec Referer. La version patchée inverse cet ordre et ferme les
réponses. Deux garanties à tenir :

  1. le booléen rendu est identique dans les quatre combinaisons possibles,
     puisqu'il s'agit d'un OU logique entre deux tentatives indépendantes ;
  2. chaque réponse obtenue est fermée — sans quoi la connexion n'est jamais
     rendue au pool et chaque vérification repaie un handshake TLS complet.

Le gain, lui, se lit dans le nombre de requêtes émises quand l'hébergeur
exige un Referer : deux avant, une seule après.
"""
import sys
from urllib.parse import urlparse

LINK = "https://cdn.example.test/stream.m3u8"


class Response:
    def __init__(self, status, log):
        self.status_code = status
        self._log = log
        self.closed = False

    def close(self):
        self.closed = True
        self._log.append(("close", self))


def make_scraper(ok_with_referer, ok_plain, log, raises=()):
    """Faux scraper : la réponse dépend de la présence d'un Referer."""
    def get(url, headers=None, timeout=None, stream=None):
        has_referer = "Referer" in (headers or {})
        kind = "avec-referer" if has_referer else "sans-referer"
        log.append(("get", kind))
        if kind in raises:
            raise RuntimeError("hôte injoignable")
        ok = ok_with_referer if has_referer else ok_plain
        return Response(200 if ok else 403, log)
    return type("Scraper", (), {"get": staticmethod(get)})()


def original(test_link, scraper):
    """Version amont, recopiée telle quelle."""
    if not test_link:
        return False
    standard_headers = {"User-Agent": "x", "Accept": "*/*"}
    try:
        r = scraper.get(test_link, headers=standard_headers, timeout=3, stream=True)
        if r.status_code in (200, 206):
            return True
    except Exception:
        pass
    parsed = urlparse(test_link)
    domain = parsed.netloc.lower()
    try:
        r = scraper.get(test_link, headers={**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"},
                        timeout=3, stream=True)
        if r.status_code in (200, 206):
            return True
    except Exception:
        pass
    return False


def patched(test_link, scraper):
    """Version installée par docker/speedup_patch.py."""
    if not test_link:
        return False
    standard_headers = {"User-Agent": "x", "Accept": "*/*"}
    parsed = urlparse(test_link)
    domain = parsed.netloc.lower()
    for headers in (
        {**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"},
        standard_headers,
    ):
        try:
            r = scraper.get(test_link, headers=headers, timeout=3, stream=True)
        except Exception:
            continue
        try:
            if r.status_code in (200, 206):
                return True
        finally:
            r.close()
    return False


def main():
    checks = failures = 0

    def check(label, ok, extra=""):
        nonlocal checks, failures
        checks += 1
        if not ok:
            failures += 1
        print(f"  {'ok ' if ok else 'KO '} {label}" + (f" :: {extra}" if extra else ""))

    # ── Même réponse dans toutes les combinaisons ────────────────────
    for with_ref in (True, False):
        for plain in (True, False):
            log_a, log_b = [], []
            a = original(LINK, make_scraper(with_ref, plain, log_a))
            b = patched(LINK, make_scraper(with_ref, plain, log_b))
            check(f"referer={with_ref!s:5} sans={plain!s:5} → {a}", a == b, f"amont {a} / patché {b}")

    # ── Même réponse quand une tentative lève ────────────────────────
    for raises in (("sans-referer",), ("avec-referer",), ("sans-referer", "avec-referer")):
        for with_ref in (True, False):
            log_a, log_b = [], []
            a = original(LINK, make_scraper(with_ref, True, log_a, raises))
            b = patched(LINK, make_scraper(with_ref, True, log_b, raises))
            check(f"exception sur {'+'.join(raises):28} referer={with_ref!s:5}", a == b)

    # ── Toute réponse obtenue est refermée ───────────────────────────
    for with_ref in (True, False):
        for plain in (True, False):
            log = []
            patched(LINK, make_scraper(with_ref, plain, log))
            gets = [e for e in log if e[0] == "get"]
            closes = [e for e in log if e[0] == "close"]
            check(f"connexions refermées (referer={with_ref!s:5} sans={plain!s:5})",
                  len(closes) == len(gets), f"{len(closes)}/{len(gets)}")

    # ── Le gain : une requête au lieu de deux quand le Referer est requis ──
    log_a, log_b = [], []
    original(LINK, make_scraper(True, False, log_a))
    patched(LINK, make_scraper(True, False, log_b))
    before = len([e for e in log_a if e[0] == "get"])
    after = len([e for e in log_b if e[0] == "get"])
    check("hébergeur exigeant un Referer : moins de requêtes", after < before,
          f"{before} → {after}")

    print(f"\n{'TOUT EST VERT' if not failures else str(failures) + ' ÉCHEC(S)'} "
          f"({checks} vérifications)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
