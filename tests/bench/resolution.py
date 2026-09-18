#!/usr/bin/env python3
"""
Banc d'essai de la résolution d'épisodes.

Il ne touche à aucun réseau réel : les appels sortants sont remplacés par des
attentes calibrées sur ce que coûte vraiment une requête vers un hébergeur
vidéo. L'intérêt n'est pas la valeur absolue mais le rapport entre stratégies,
qui lui ne dépend pas de la machine.

Deux latences distinctes sont simulées, parce que c'est précisément ce qui
décide du résultat :
  · un hébergeur rapide répond en ~0,25 s ;
  · un hébergeur poussif ou à moitié mort met plus d'une seconde, et il faut
    l'attendre avant d'essayer le suivant quand on les enchaîne.

    python3 tests/bench/resolution.py
"""
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError

EPISODES = 25
WORKERS = 6

# Latence par hébergeur, en secondes. Le deuxième est volontairement lent :
# c'est le cas qui sépare une stratégie séquentielle d'une stratégie parallèle.
HOST_LATENCY = {"eps1": 0.25, "eps2": 1.10, "eps3": 0.40}
CHECK_LATENCY = 0.20        # vérification « ce flux est-il lisible ? »


def make_world(seed):
    """Une saison plausible : trois lecteurs, des trous, des liens morts."""
    rnd = random.Random(seed)
    lecteurs = list(HOST_LATENCY)
    all_eps = {}
    for lecteur in lecteurs:
        urls = []
        for ep in range(EPISODES):
            r = rnd.random()
            if r < 0.12:
                urls.append("")
            else:
                urls.append(f"https://{lecteur}.test/{ep}")
        all_eps[lecteur] = urls

    # Le premier lecteur ne résout qu'une fois sur deux : sans ça, on ne
    # mesurerait jamais le coût d'un second essai.
    resolvable, playable = {}, set()
    for lecteur in lecteurs:
        for url in all_eps[lecteur]:
            if not url:
                continue
            if rnd.random() < (0.5 if lecteur == "eps1" else 0.85):
                target = url + ".m3u8"
                resolvable[url] = {"url": target, "type": "m3u8"}
                if rnd.random() < 0.9:
                    playable.add(target)
            else:
                resolvable[url] = None
    return lecteurs, all_eps, resolvable, playable


def build_stubs(resolvable, playable, counter=None):
    """`counter` compte les requêtes sortantes : c'est le prix à mettre en
    face du gain de latence, une stratégie parallèle sollicitant davantage
    les hébergeurs."""
    def host_of(url):
        for lecteur in HOST_LATENCY:
            if f"//{lecteur}." in url:
                return lecteur
        return "eps1"

    def resolve_video_url(url):
        if counter is not None:
            counter[0] += 1
        time.sleep(HOST_LATENCY[host_of(url)])
        return resolvable.get(url)

    def is_stream_playable(link):
        if counter is not None:
            counter[0] += 1
        time.sleep(CHECK_LATENCY)
        return bool(link) and link in playable

    return resolve_video_url, is_stream_playable


# ─────────────────────────────────────────────
#  Stratégies
# ─────────────────────────────────────────────
def _try_one(lecteur, all_eps, episode, resolve_video_url, is_stream_playable):
    """Tente un seul lecteur pour un épisode. Rend le lien ou None."""
    eps_list = all_eps[lecteur]
    if episode >= len(eps_list):
        return None
    url = eps_list[episode].strip(" \t\n\r\xa0")
    if not url:
        return None
    is_sibnet = "sibnet.ru" in url.lower()
    try:
        resolved = resolve_video_url(url)
    except Exception:
        resolved = None
    if resolved and isinstance(resolved, dict):
        target, kind = resolved.get("url"), resolved.get("type")
        if kind in ("m3u8", "mp4", "embed") and target and is_stream_playable(target):
            return target
    if is_sibnet and is_stream_playable(url):
        return url
    return None


def resolve_sequential(lecteurs, all_eps, episode, rv, isp):
    """Version actuelle : les lecteurs sont enchaînés jusqu'au premier bon."""
    for lecteur in lecteurs:
        link = _try_one(lecteur, all_eps, episode, rv, isp)
        if link:
            return link
    return None


def resolve_concurrent(lecteurs, all_eps, episode, rv, isp):
    """Tous les lecteurs lancés en même temps, mais on retient celui de plus
    haute priorité qui a réussi : le lien rendu est identique à la version
    séquentielle, seule l'attente change.

    Le pool n'est volontairement pas utilisé comme gestionnaire de contexte :
    `with` attend la fin de *toutes* les tâches en sortant, ce qui annulerait
    tout le bénéfice du retour anticipé."""
    pool = ThreadPoolExecutor(max_workers=len(lecteurs))
    try:
        futures = [pool.submit(_try_one, l, all_eps, episode, rv, isp) for l in lecteurs]
        for future in futures:                 # ordre de priorité, pas d'arrivée
            link = future.result()
            if link:
                return link
        return None
    finally:
        pool.shutdown(wait=False)


def resolve_hedged(lecteurs, all_eps, episode, rv, isp, patience=0.45):
    """Compromis : on tente le premier lecteur seul, et on ne réveille les
    autres que s'il tarde. Le cas courant ne coûte donc qu'une requête, et
    seul le cas lent paie le surcoût du parallélisme."""
    pool = ThreadPoolExecutor(max_workers=len(lecteurs))
    try:
        first = pool.submit(_try_one, lecteurs[0], all_eps, episode, rv, isp)
        try:
            link = first.result(timeout=patience)
            if link:
                return link
            rest = lecteurs[1:]
        except TimeoutError:
            rest = lecteurs[1:]                # il traîne : on double la mise

        futures = [pool.submit(_try_one, l, all_eps, episode, rv, isp) for l in rest]
        if not first.done() or first.result():
            link = first.result()
            if link:
                return link
        for future in futures:
            link = future.result()
            if link:
                return link
        return None
    finally:
        pool.shutdown(wait=False)


def season(order, resolver, lecteurs, all_eps, rv, isp):
    """Résout toute la saison dans l'ordre donné, et rend la date à laquelle
    chaque épisode est devenu disponible."""
    ready = {}
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(resolver, lecteurs, all_eps, ep, rv, isp): ep for ep in order}
        for future in futures:
            future.result()
            ready[futures[future]] = time.perf_counter() - start
    return ready


def centred(target, total):
    """Ordonne les épisodes autour de celui qu'on regarde : le suivant d'abord,
    puis le précédent, et ainsi de suite."""
    order, offset = [target], 1
    while len(order) < total:
        for ep in (target + offset, target - offset):
            if 0 <= ep < total and ep not in order:
                order.append(ep)
        offset += 1
    return order


def main():
    seeds = [1, 2, 3, 4, 5]
    strategies = [
        ("enchaînés (actuel)", resolve_sequential),
        ("simultanés", resolve_concurrent),
        ("prudent (hedged)", resolve_hedged),
    ]
    results = {name: {"times": [], "calls": 0} for name, _ in strategies}
    reference, same = {}, True

    print(f"Saison de {EPISODES} épisodes · {WORKERS} threads")
    print(f"Lecteurs : " + ", ".join(f"{k} {v:.2f}s" for k, v in HOST_LATENCY.items())
          + f" · vérification {CHECK_LATENCY:.2f}s\n")

    print("── Épisode prioritaire : délai avant de pouvoir lancer la lecture")
    for seed in seeds:
        lecteurs, all_eps, resolvable, playable = make_world(seed)
        for ep in (0, EPISODES // 3, EPISODES // 2, EPISODES - 1):
            for name, strategy in strategies:
                counter = [0]
                rv, isp = build_stubs(resolvable, playable, counter)
                t0 = time.perf_counter()
                link = strategy(lecteurs, all_eps, ep, rv, isp)
                results[name]["times"].append(time.perf_counter() - t0)
                results[name]["calls"] += counter[0]
                key = (seed, ep)
                if name == strategies[0][0]:
                    reference[key] = link
                elif reference[key] != link:
                    same = False
                    print(f"   DIVERGENCE {name} seed={seed} ep={ep}")

    base = statistics.median(results[strategies[0][0]]["times"])
    for name, _ in strategies:
        times = sorted(results[name]["times"])
        med = statistics.median(times)
        p90 = times[int(len(times) * 0.9)]
        print(f"   {name:20} médiane {med:5.2f} s · p90 {p90:5.2f} s · "
              f"pire {times[-1]:5.2f} s · {results[name]['calls']:4d} requêtes"
              + (f" · ×{base / med:.2f}" if name != strategies[0][0] else ""))
    print(f"   liens identiques dans les trois stratégies : {'oui' if same else 'NON'}\n")

    print("── Saison en tâche de fond : quand l'épisode suivant devient jouable")
    target = EPISODES // 2
    for label, order in (("ordre actuel 0…N", list(range(EPISODES))),
                         ("centré sur la cible", centred(target, EPISODES))):
        lecteurs, all_eps, resolvable, playable = make_world(1)
        rv, isp = build_stubs(resolvable, playable)
        ready = season(order, resolve_sequential, lecteurs, all_eps, rv, isp)
        after = [ready[e] for e in sorted(ready) if e > target]
        print(f"   {label:22} suivant prêt à {ready.get(target + 1, float('nan')):5.2f} s "
              f"· 5 suivants à {max(after[:5]):5.2f} s "
              f"· saison entière {max(ready.values()):5.2f} s")

    print("\n── Nombre de threads : gain contre pression sur les hébergeurs")
    for workers in (4, 6, 8, 12, 16):
        lecteurs, all_eps, resolvable, playable = make_world(1)
        counter = [0]
        rv, isp = build_stubs(resolvable, playable, counter)
        order = centred(EPISODES // 2, EPISODES)
        t0 = time.perf_counter()
        pool = ThreadPoolExecutor(max_workers=workers)
        futures = {pool.submit(resolve_sequential, lecteurs, all_eps, ep, rv, isp): ep
                   for ep in order}
        for future in futures:
            future.result()
        pool.shutdown()
        total = time.perf_counter() - t0
        peak = min(workers, EPISODES)
        print(f"   {workers:2d} threads · saison entière {total:5.2f} s · "
              f"{counter[0]} requêtes · jusqu'à {peak} connexions simultanées")

    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
