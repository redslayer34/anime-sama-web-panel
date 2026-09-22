#!/usr/bin/env python3
"""
Réglages recopiés en plusieurs endroits : ils doivent rester d'accord.

1. Nombre de résolutions simultanées : une seule source de vérité.

`WORKERS_DEFAULT` (docker/speedup_patch.py) fixe la valeur par défaut, mais
une variable d'environnement la surcharge. Le Dockerfile et render.yaml en
posaient une chacun, restée à 6 quand le défaut est passé à 8 : le gain était
mesuré, documenté, et pourtant inactif en production. Ce test fait échouer la
campagne dès qu'un de ces fichiers diverge à nouveau.

2. Modules de js/ : index.html les précharge tous (sans quoi ils se
découvrent niveau par niveau), et l'image Docker embarque le dossier.
"""
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KEY = "PANEL_RESOLVER_WORKERS"


def workers_default():
    tree = ast.parse((ROOT / "docker" / "speedup_patch.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "WORKERS_DEFAULT" for t in node.targets):
            return str(ast.literal_eval(node.value))
    return None


def render_value():
    """Valeur de la clé dans render.yaml, sans dépendre d'un parseur YAML."""
    lines = (ROOT / "render.yaml").read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if re.match(rf"\s*-\s*key:\s*{KEY}\s*$", line):
            for follow in lines[i + 1:i + 4]:
                found = re.match(r"\s*value:\s*\"?([^\"\s]+)\"?\s*$", follow)
                if found:
                    return found.group(1)
            return "(clé sans valeur)"
    return None


def main():
    checks = failures = 0

    def check(label, ok, extra=""):
        nonlocal checks, failures
        checks += 1
        if not ok:
            failures += 1
        print(f"  {'ok ' if ok else 'KO '} {label}" + (f" :: {extra}" if extra else ""))

    default = workers_default()
    check("WORKERS_DEFAULT lisible dans speedup_patch.py", default is not None and default.isdigit(),
          repr(default))

    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    overrides = re.findall(rf"{KEY}\s*=\s*(\S+)", dockerfile)
    check("le Dockerfile ne surcharge pas le défaut", not overrides,
          f"{KEY}={overrides[0]}" if overrides else "")

    value = render_value()
    check("render.yaml annonce le défaut (ou ne dit rien)", value in (None, default),
          f"render.yaml={value}, défaut={default}")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    documented = re.findall(rf"{KEY}[^\n]*?\((\d+) par défaut\)", readme)
    check("le README documente le défaut", bool(documented))
    check("le README annonce la bonne valeur", all(d == default for d in documented),
          f"README={sorted(set(documented))}, défaut={default}")

    modules = sorted(p.name for p in (ROOT / "js").glob("*.js"))
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    entry = re.findall(r'<script type="module" src="js/([\w-]+\.js)"', html)
    preloaded = re.findall(r'<link rel="modulepreload" href="js/([\w-]+\.js)"', html)
    check("index.html charge js/main.js en module", entry == ["main.js"], str(entry))
    missing = sorted(set(modules) - set(preloaded) - {"main.js"})
    check("chaque module de js/ est préchargé", not missing, ", ".join(missing))
    stale = sorted(set(preloaded) - set(modules))
    check("aucun préchargement vers un module disparu", not stale, ", ".join(stale))
    check("le Dockerfile copie js/", re.search(r"^COPY js/ ", dockerfile, re.M) is not None)

    print(f"\n{'TOUT EST VERT' if not failures else str(failures) + ' ÉCHEC(S)'} "
          f"({checks} vérifications)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
