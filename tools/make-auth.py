#!/usr/bin/env python3
"""يولّد data/auth.json: بصمات PBKDF2 لكلمات سر الحسابات والملف الخاص (مش كلمات السر نفسها).
تغيير كلمة سر:  python3 tools/make-auth.py "email1:pass1" "email2:pass2" --priv "كلمة-سر-الخاص"
أي تغيير بيلغي جلسات الحساب القديمة تلقائياً."""
import base64, hashlib, json, os, secrets, sys
ITER = 100000
b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
def rec(pw):
    if len(pw) < 10: raise SystemExit("كلمة السر لازم تكون 10 أحرف أو أكثر")
    salt = secrets.token_bytes(16)
    return {"salt": b64(salt), "hash": b64(hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITER)), "iter": ITER}
args = sys.argv[1:]; priv = None
if "--priv" in args:
    i = args.index("--priv"); priv = args[i + 1]; del args[i:i + 2]
out = {"version": 1, "accounts": {}}
for a in args:
    e, p = a.split(":", 1); out["accounts"][e.strip().lower()] = rec(p)
if priv: out["priv"] = rec(priv)
path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "auth.json")
json.dump(out, open(path, "w"), indent=1); print("✓", path, len(out["accounts"]), "حساب")
