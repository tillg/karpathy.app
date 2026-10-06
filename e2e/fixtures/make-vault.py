#!/usr/bin/env python3
"""Generate a large test vault (German/English/French notes, frontmatter, wikilinks) as a bare repo."""
import os, random, subprocess, sys, shutil
random.seed(42)
out = sys.argv[1]            # e.g. tmp/dev/remotes/demo/vault.git
n = int(sys.argv[2]) if len(sys.argv) > 2 else 200
work = out + ".work"
shutil.rmtree(work, ignore_errors=True); shutil.rmtree(out, ignore_errors=True)
os.makedirs(work)
folders = ["wiki/concepts", "wiki/entities", "wiki/topics", "journal", "projects/alpha", "projects/beta", "raw/articles"]
words = ["Wissen", "idée", "knowledge", "graph", "Notiz", "vault", "agent", "Markdown", "Obsidian", "Frechen",
         "réflexion", "Karpathy", "LLM", "wiki", "Gedanke", "Projekt", "sync", "git", "commit", "Suche"]
titles = [f"{random.choice(words).capitalize()} {random.choice(words)} {i}" for i in range(n)]
paths = [f"{random.choice(folders)}/{t}.md" for t in titles]
for i, (t, p) in enumerate(zip(titles, paths)):
    links = random.sample(titles, 3)
    body = " ".join(random.choice(words) for _ in range(random.randint(20, 120)))
    fm = f"---\ntype: {random.choice(['concept','entity','topic','source'])}\ntags: [{random.choice(words).lower()}, test]\nupdated: 2026-09-{random.randint(1,25):02d}\n---\n\n"
    text = f"{fm}# {t}\n\n{body}\n\n## Links\n\n- [[{links[0]}]]\n- [[{links[1]}|alias {i}]]\n- [[{links[2]}#Links]]\n\n- [ ] task {i}\n- **bold** and *italic* and `code`\n"
    os.makedirs(os.path.dirname(os.path.join(work, p)), exist_ok=True)
    open(os.path.join(work, p), "w").write(text)
open(os.path.join(work, "Home.md"), "w").write("# Home\n\nWelcome to the test vault. See [[Ideas]] and [[" + titles[0] + "]].\n\nÄÖÜ ß é è — unicode check.\n")
open(os.path.join(work, "Ideas.md"), "w").write("# Ideas\n\nBack to [[Home]].\n")
# Required vault structure: wiki/ already counts as Wiki (case-insensitive); Sources/ needs a placeholder.
os.makedirs(os.path.join(work, "Sources")); open(os.path.join(work, "Sources", ".gitkeep"), "w").close()
open(os.path.join(work, "AGENTS.md"), "w").write("# Test vault\n\nThis is a throwaway test vault. Keep answers short.\n")
# Already in the .agents standard, so opening the vault doesn't move anything (the agents move).
open(os.path.join(work, "CLAUDE.md"), "w").write("@AGENTS.md\n")
os.makedirs(os.path.join(work, ".agents", "skills", "hello"))
open(os.path.join(work, ".agents", "skills", "hello", "SKILL.md"), "w").write("---\nname: hello\ndescription: Says hello to the user\n---\n\nGreet the user in one short sentence.\n")
g = lambda *a: subprocess.run(["git", *a], cwd=work, check=True, capture_output=True)
g("init", "-q", "-b", "main"); g("add", "-A"); g("-c", "user.name=seed", "-c", "user.email=s@s", "commit", "-qm", f"Seed {n} notes")
subprocess.run(["git", "clone", "-q", "--bare", work, out], check=True)
shutil.rmtree(work)
print(f"{out}: {n + 3} files")
