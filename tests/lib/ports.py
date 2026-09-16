"""Libère un port TCP en arrêtant le processus qui l'écoute.

Passe par /proc plutôt que par un motif de ligne de commande : `pkill -f` finit
toujours par se reconnaître lui-même et par tuer le shell appelant."""
import glob
import os
import sys


def listeners(port):
    inodes = set()
    try:
        lines = open("/proc/net/tcp").read().splitlines()[1:]
        lines += open("/proc/net/tcp6").read().splitlines()[1:]
    except OSError:
        return []                      # pas de /proc : rien à faire (Windows, macOS)
    for line in lines:
        parts = line.split()
        if len(parts) < 10 or parts[3] != "0A":        # 0A = LISTEN
            continue
        if int(parts[1].split(":")[1], 16) == port:
            inodes.add(parts[9])

    pids = []
    for fd in glob.glob("/proc/[0-9]*/fd/*"):
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith("socket:[") and target[8:-1] in inodes:
            pids.append(int(fd.split("/")[2]))
    return sorted(set(pids))


def free(*ports):
    for port in ports:
        for pid in listeners(port):
            try:
                os.kill(pid, 15)
            except OSError:
                pass


if __name__ == "__main__":
    free(*[int(a) for a in sys.argv[1:]])
