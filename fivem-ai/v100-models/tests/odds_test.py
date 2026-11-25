import json, time, urllib.request

SYS = ("You are a deterministic odds compiler. Input is one or more matches. "
       "For each match, adjust prices numerically based on form and injuries. "
       'Return ONLY a JSON object: {"matches":[{"home":str,"h2h":[{"name":str,"price":num}],'
       '"totals":[{"name":str,"price":num,"point":num}],"confidence":num,"adjustments":[str]}]}. '
       "Keep adjustments to <=3 short snake_case tags. No prose outside JSON.")

M1 = "M1: Arsenal v Chelsea EPL h2h 1.90/3.5/4.2 OU2.5 1.87/1.95 form WWWDW/LDWLL Chelsea striker out."
M2 = "M2: Bayern v Dortmund BL h2h 1.55/4.5/5.5 OU3.5 1.90/1.90 form WWWWW/WDLWW."
M3 = "M3: PSG v Lyon L1 h2h 1.40/5.0/7.0 OU2.5 1.75/2.05 form WWDWW/LLDWL PSG 2 defenders out."
M4 = "M4: Inter v Milan SA h2h 2.10/3.3/3.6 OU2.5 1.95/1.87 form WDWWL/WWDLW."
M5 = "M5: RealMadrid v Sevilla LL h2h 1.45/4.6/6.5 OU2.5 1.70/2.10 form WWWDW/LDLWL Sevilla GK out."
M6 = "M6: Liverpool v Spurs EPL h2h 1.75/3.9/4.6 OU3.5 2.00/1.80 form WWDWW/DLWWL."
M7 = "M7: Juventus v Napoli SA h2h 2.40/3.1/3.1 OU2.5 2.05/1.78 form DWWDL/WWWDW."
M8 = "M8: Atletico v Barca LL h2h 3.0/3.3/2.4 OU2.5 1.85/1.95 form WDWWW/WWDWW Atletico winger out."

def call(url, model, user, max_tokens):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": user}],
        "temperature": 0.1, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    dt = time.time() - t0
    content = d["choices"][0]["message"]["content"]
    usage = d.get("usage", {})
    try:
        parsed = json.loads(content)
        n = len(parsed.get("matches", parsed if isinstance(parsed, list) else [parsed]))
        ok = "VALID_JSON matches=%d" % n
    except Exception as e:
        ok = "INVALID_JSON: %s" % e
    return dt, usage, ok, content

URL = "http://192.168.50.208:8001/v1/chat/completions"
tests = [("1-match", "\n".join([M1]), 500),
         ("3-match", "\n".join([M1,M2,M3]), 1400),
         ("8-match", "\n".join([M1,M2,M3,M4,M5,M6,M7,M8]), 3200)]
for label, user, mt in tests:
    try:
        dt, usage, ok, content = call(URL, "/model", user, mt)
        print("[%s] %.2fs | comp_tok=%s | %s" % (label, dt, usage.get("completion_tokens","?"), ok))
    except Exception as e:
        print("[%s] ERROR %s" % (label, e))
