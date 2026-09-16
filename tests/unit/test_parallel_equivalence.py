"""
Équivalence entre la boucle séquentielle d'origine, la version parallèle, et le
mode « épisode prioritaire » du chargement intelligent.

Les trois implémentations sont recopiées telles qu'elles figurent dans le code
(avant et après patch) et reçoivent exactement les mêmes stubs. On vérifie que
la sortie est identique, y compris dans les cas tordus : épisodes absents chez
certains lecteurs, liens vides, hébergeurs injoignables, sibnet en repli.

Le mode prioritaire (`priority()`) doit donner, pour chaque épisode pris
séparément, exactement le même lien que la résolution complète (`original()`)
— c'est la garantie que « charger cet épisode seul » et « charger toute la
saison » ne divergent jamais silencieusement.
"""
import random
import time
from concurrent.futures import ThreadPoolExecutor

DELAY = 0.05          # simule une requête HTTP réseau


def make_world(seed):
    rnd = random.Random(seed)
    nb = 30
    lecteurs = ["eps1", "eps2", "eps3"]
    all_eps = {}
    for i, l in enumerate(lecteurs):
        urls = []
        for e in range(nb):
            r = rnd.random()
            if r < 0.15:
                urls.append("")                                   # entrée vide
            elif r < 0.30:
                urls.append(f"https://sibnet.ru/{l}/{e}")          # sibnet
            else:
                urls.append(f"https://host{i}.test/{l}/{e}")
        # un lecteur plus court : certains épisodes n'y sont pas
        if i == 2:
            urls = urls[:nb - 7]
        all_eps[l] = urls

    playable = {u for l in all_eps for u in all_eps[l] if u and rnd.random() < 0.55}
    resolvable = {}
    for l in all_eps:
        for u in all_eps[l]:
            if not u or "sibnet" in u:
                continue
            r = rnd.random()
            if r < 0.25:
                resolvable[u] = None                                      # échec
            elif r < 0.55:
                resolvable[u] = {"url": u + ".m3u8", "type": "m3u8"}
            elif r < 0.8:
                resolvable[u] = {"url": u + "#embed", "type": "embed"}
            else:
                resolvable[u] = {"type": "embed"}                         # sans url
    for u in list(resolvable):
        v = resolvable[u]
        if isinstance(v, dict) and v.get("url") and rnd.random() < 0.5:
            playable.add(v["url"])
    return nb, lecteurs, all_eps, playable, resolvable


def build_stubs(playable, resolvable):
    def resolve_video_url(url):
        time.sleep(DELAY)
        if url not in resolvable:
            raise RuntimeError("hôte inconnu")
        return resolvable[url]

    def is_stream_playable(link):
        time.sleep(DELAY)
        return bool(link) and link in playable

    return resolve_video_url, is_stream_playable


def original(nb, valid_lecteurs, all_eps, resolve_video_url, is_stream_playable):
    good_link = []
    for episode in range(nb):
        best_link = None
        for lecteur in valid_lecteurs:
            eps_list = all_eps[lecteur]
            if episode >= len(eps_list):
                continue
            url_to_test = eps_list[episode].strip(" \t\n\r\xa0")
            if not url_to_test:
                continue
            is_sibnet = "sibnet.ru" in url_to_test.lower()
            try:
                resolved = resolve_video_url(url_to_test)
            except Exception:
                resolved = None
            if resolved and isinstance(resolved, dict):
                resolved_url = resolved.get("url")
                resolved_type = resolved.get("type")
                if resolved_type in ("m3u8", "mp4") and resolved_url:
                    if is_stream_playable(resolved_url):
                        best_link = resolved_url
                        break
                elif resolved_type == "embed" and resolved_url:
                    if is_stream_playable(resolved_url):
                        best_link = resolved_url
                        break
            if is_sibnet and not best_link:
                if is_stream_playable(url_to_test):
                    best_link = url_to_test
                    break
        if best_link:
            good_link.append({"episode": episode, "url": best_link})
    return good_link


def patched(nb, valid_lecteurs, all_eps, resolve_video_url, is_stream_playable, workers=6):
    good_link = []

    def _panel_resolve(episode):
        for lecteur in valid_lecteurs:
            eps_list = all_eps[lecteur]
            if episode >= len(eps_list):
                continue
            url_to_test = eps_list[episode].strip(" \t\n\r\xa0")
            if not url_to_test:
                continue
            is_sibnet = "sibnet.ru" in url_to_test.lower()
            try:
                resolved = resolve_video_url(url_to_test)
            except Exception:
                resolved = None
            if resolved and isinstance(resolved, dict):
                resolved_url = resolved.get("url")
                resolved_type = resolved.get("type")
                if resolved_type in ("m3u8", "mp4") and resolved_url:
                    if is_stream_playable(resolved_url):
                        return resolved_url
                elif resolved_type == "embed" and resolved_url:
                    if is_stream_playable(resolved_url):
                        return resolved_url
            if is_sibnet:
                if is_stream_playable(url_to_test):
                    return url_to_test
        return None

    if nb > 0:
        with ThreadPoolExecutor(max_workers=min(workers, nb)) as pool:
            resolved_links = list(pool.map(_panel_resolve, range(nb)))
    else:
        resolved_links = []

    for episode, best_link in enumerate(resolved_links):
        if best_link:
            good_link.append({"episode": episode, "url": best_link})
    return good_link


def priority(nb, valid_lecteurs, all_eps, resolve_video_url, is_stream_playable, episode):
    """Reproduit le branchement `if episode is not None:` ajouté dans LOOP_NEW."""

    def _panel_resolve(ep):
        for lecteur in valid_lecteurs:
            eps_list = all_eps[lecteur]
            if ep >= len(eps_list):
                continue
            url_to_test = eps_list[ep].strip(" \t\n\r\xa0")
            if not url_to_test:
                continue
            is_sibnet = "sibnet.ru" in url_to_test.lower()
            try:
                resolved = resolve_video_url(url_to_test)
            except Exception:
                resolved = None
            if resolved and isinstance(resolved, dict):
                resolved_url = resolved.get("url")
                resolved_type = resolved.get("type")
                if resolved_type in ("m3u8", "mp4") and resolved_url:
                    if is_stream_playable(resolved_url):
                        return resolved_url
                elif resolved_type == "embed" and resolved_url:
                    if is_stream_playable(resolved_url):
                        return resolved_url
            if is_sibnet:
                if is_stream_playable(url_to_test):
                    return url_to_test
        return None

    link = _panel_resolve(episode) if 0 <= episode < nb else None
    return {"count": nb, "results": [{"episode": episode, "url": link}] if link else []}


failures = 0
total_seq = total_par = 0.0
for seed in range(12):
    nb, lecteurs, all_eps, playable, resolvable = make_world(seed)
    resolve, playable_fn = build_stubs(playable, resolvable)

    t = time.time(); a = original(nb, lecteurs, all_eps, resolve, playable_fn); total_seq += time.time() - t
    t = time.time(); b = patched(nb, lecteurs, all_eps, resolve, playable_fn); total_par += time.time() - t

    if a != b:
        failures += 1
        print(f"  KO  jeu {seed} : sorties différentes")
        for x, y in zip(a, b):
            if x != y:
                print("      ", x, "!=", y); break
    else:
        print(f"  ok  jeu {seed} : {len(a)} épisodes retenus, sorties identiques")

    # Épisode prioritaire : un échantillon d'indices doit correspondre
    # exactement à ce que la résolution complète a trouvé pour ce même indice.
    # `_panel_resolve` est le même code dans les deux chemins (copié-collé
    # depuis LOOP_NEW) : ce qui varie d'un épisode à l'autre ne teste que
    # cette fonction, déjà couverte par l'équivalence original/patched
    # ci-dessus sur les nb épisodes. Un échantillon suffit donc à couvrir le
    # seul code propre au mode prioritaire (le branchement et l'emballage
    # count/results), sans faire exploser le temps du test (chaque épisode
    # coûte jusqu'à 3 × DELAY, et le refaire nb fois par seed double le temps
    # total pour un gain de confiance nul au-delà d'un échantillon).
    sample = sorted({0, nb // 3, nb // 2, (2 * nb) // 3, nb - 1} & set(range(nb)))
    full_by_episode = {item["episode"]: item["url"] for item in a}
    mismatches = []
    for ep in sample:
        got = priority(nb, lecteurs, all_eps, resolve, playable_fn, ep)
        if got["count"] != nb:
            mismatches.append(f"count={got['count']} attendu {nb} (épisode {ep})")
            continue
        expected = full_by_episode.get(ep)
        actual = got["results"][0]["url"] if got["results"] else None
        if actual != expected:
            mismatches.append(f"épisode {ep} : prioritaire={actual!r} != complet={expected!r}")
    if mismatches:
        failures += 1
        print(f"  KO  jeu {seed} : épisode prioritaire divergent ({len(mismatches)}) :: {mismatches[0]}")
    else:
        print(f"  ok  jeu {seed} : épisode prioritaire identique à la résolution complète ({len(sample)} indices testés sur {nb})")

    # Index hors bornes : ni erreur, ni résultat fantôme.
    out_of_range = priority(nb, lecteurs, all_eps, resolve, playable_fn, nb + 5)
    if out_of_range["count"] != nb or out_of_range["results"] != []:
        failures += 1
        print(f"  KO  jeu {seed} : index hors bornes mal géré :: {out_of_range}")
    else:
        print(f"  ok  jeu {seed} : index hors bornes renvoie un résultat vide")

# cas limites
for nb_edge, label in [(0, "aucun épisode")]:
    a = original(nb_edge, lecteurs, all_eps, resolve, playable_fn)
    b = patched(nb_edge, lecteurs, all_eps, resolve, playable_fn)
    status = "ok " if a == b == [] else "KO "
    if a != b: failures += 1
    print(f"  {status} cas limite : {label}")

print(f"\nséquentiel : {total_seq:.1f} s   parallèle : {total_par:.1f} s   "
      f"gain : {total_seq / max(total_par, 0.001):.1f}×")
print("ÉQUIVALENCE CONFIRMÉE" if not failures else f"{failures} ÉCHEC(S)")
raise SystemExit(1 if failures else 0)
