import json, time, urllib.request

URL = "http://192.168.50.209:8081/v1/chat/completions"

# DESIGN: model emits JUDGMENT (direction + magnitude of adjustment + confidence),
# NOT final prices. hk-odds-engine does the exact vig/price math in code.
SYS = (
 "You are a football odds analyst. For each input match you are given the current "
 "sportsbook odds plus recent form and injury notes. Your job is NOT to compute final "
 "prices. Your job is to output, per match, how the TRUE probabilities should shift "
 "relative to the current market, based on form and injuries.\n"
 "For each match output: home_shift, draw_shift, away_shift (each a fraction of "
 "probability mass to move, range -0.15..0.15, they should roughly sum to ~0), "
 "totals_shift (positive = lean Over, negative = lean Under, range -0.15..0.15), "
 "confidence (0..1), and adjustments (<=3 short snake_case tags). "
 "Base your shifts only on the form/injury evidence given. If no evidence, shifts are 0."
)

SCHEMA = {
  "type": "object",
  "properties": {
    "matches": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "home": {"type": "string"},
          "home_shift": {"type": "number"},
          "draw_shift": {"type": "number"},
          "away_shift": {"type": "number"},
          "totals_shift": {"type": "number"},
          "confidence": {"type": "number"},
          "adjustments": {"type": "array", "items": {"type": "string"}, "maxItems": 3}
        },
        "required": ["home","home_shift","draw_shift","away_shift","totals_shift","confidence","adjustments"]
      }
    }
  },
  "required": ["matches"]
}

M = [
 "M1: Arsenal(home) v Chelsea EPL. Market h2h 1.90/3.5/4.2, OU2.5 1.87/1.95. Form Arsenal WWWDW, Chelsea LDWLL. Chelsea first-choice striker OUT injured.",
 "M2: Bayern(home) v Dortmund BL. Market h2h 1.55/4.5/5.5, OU3.5 1.90/1.90. Form Bayern WWWWW, Dortmund WDLWW. No injuries noted.",
 "M3: PSG(home) v Lyon L1. Market h2h 1.40/5.0/7.0, OU2.5 1.75/2.05. Form PSG WWDWW, Lyon LLDWL. PSG 2 starting defenders OUT.",
 "M4: Inter(home) v Milan SA. Market h2h 2.10/3.3/3.6, OU2.5 1.95/1.87. Form Inter WDWWL, Milan WWDLW.",
 "M5: RealMadrid(home) v Sevilla LL. Market h2h 1.45/4.6/6.5, OU2.5 1.70/2.10. Form RM WWWDW, Sevilla LDLWL. Sevilla starting GK OUT.",
 "M6: Liverpool(home) v Spurs EPL. Market h2h 1.75/3.9/4.6, OU3.5 2.00/1.80. Form LFC WWDWW, Spurs DLWWL.",
 "M7: Juventus(home) v Napoli SA. Market h2h 2.40/3.1/3.1, OU2.5 2.05/1.78. Form Juve DWWDL, Napoli WWWDW.",
 "M8: Atletico(home) v Barca LL. Market h2h 3.0/3.3/2.4, OU2.5 1.85/1.95. Form Atleti WDWWW, Barca WWDWW. Atletico key winger OUT.",
]

def call(user, max_tokens):
    body = json.dumps({
        "messages": [{"role":"system","content":SYS},{"role":"user","content":user}],
        "temperature": 0.1, "top_p": 0.9, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type":"json_schema","json_schema":{"name":"odds","schema":SCHEMA,"strict":True}},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type":"application/json"})
    t0=time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        d=json.loads(r.read())
    dt=time.time()-t0
    c=d["choices"][0]["message"]["content"]; tim=d.get("timings",{}); u=d.get("usage",{})
    try:
        p=json.loads(c); ok="VALID matches=%d"%len(p.get("matches",[]))
    except Exception as e:
        ok="INVALID(%s)"%e; p=None
    return dt,u.get("completion_tokens","?"),tim.get("predicted_per_second"),ok,c,p

# warm
try: call(M[0],200)
except Exception as e: print("warm",e)

for name,cnt,mt in [("1-match",1,300),("5-match",5,1200),("10-match",10,2400)]:
    src = M[:cnt] if cnt<=8 else M+M[:cnt-8]
    try:
        dt,ct,tps,ok,c,p=call("\n".join(src),mt)
        print("[%s] %.2fs (%.2fs/match) comp_tok=%s %.0f tok/s | %s"%(name,dt,dt/cnt,ct,tps or 0,ok))
        if name=="1-match" and p: print("   OUT:",json.dumps(p["matches"][0]))
        if name=="5-match" and p:
            for m in p["matches"][:2]: print("   ->",json.dumps(m))
    except Exception as e:
        print("[%s] ERROR %s"%(name,e))
