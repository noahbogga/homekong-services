import json, urllib.request
URL = "http://192.168.50.209:8081/v1/chat/completions"

SYS = (
 "You are a football odds analyst. You are given a match's current sportsbook odds plus "
 "recent form and injury notes. Do NOT compute final prices. Decide ONE thing: which side "
 "the evidence favors, and how strongly.\n\n"
 "Output a single number `edge` in home_shift, and set the others by STRICT RULES:\n"
 "  - Decide the favored side from evidence: HOME, AWAY, or NEITHER.\n"
 "  - Let M = magnitude from the rubric below (>=0).\n"
 "  - If HOME favored:  home_shift=+M, away_shift=-M, draw_shift=0.\n"
 "  - If AWAY favored:  home_shift=-M, away_shift=+M, draw_shift=0.\n"
 "  - If NEITHER:       home_shift=0, away_shift=0, draw_shift=0.\n"
 "  - home_shift + away_shift MUST equal 0 exactly. Never make both positive.\n"
 "totals_shift is independent: positive = lean Over, negative = lean Under, 0 if no signal.\n\n"
 "MAGNITUDE RUBRIC (M) — be conservative, markets are efficient:\n"
 "  0.00      = no relevant evidence (use NEITHER)\n"
 "  0.01-0.02 = weak single soft signal (slight form edge)\n"
 "  0.03-0.05 = clear single signal (strong form gap, OR one key injury)\n"
 "  0.06-0.08 = multiple aligned signals (strong form gap AND key injury)\n"
 "  0.10 max  = overwhelming and rare (form collapse + multiple key injuries)\n"
 "Never exceed 0.10. Most matches sit at 0.00-0.04. confidence 0..1. adjustments <=3 snake_case tags."
)
SCHEMA = {"type":"object","properties":{"matches":{"type":"array","items":{"type":"object","properties":{
  "home":{"type":"string"},"home_shift":{"type":"number"},"draw_shift":{"type":"number"},
  "away_shift":{"type":"number"},"totals_shift":{"type":"number"},"confidence":{"type":"number"},
  "adjustments":{"type":"array","items":{"type":"string"},"maxItems":3}},
  "required":["home","home_shift","draw_shift","away_shift","totals_shift","confidence","adjustments"]}}},"required":["matches"]}

def call(user):
    body=json.dumps({"messages":[{"role":"system","content":SYS},{"role":"user","content":user}],
        "temperature":0.1,"top_p":0.9,"stream":False,"max_tokens":300,"seed":42,
        "response_format":{"type":"json_schema","json_schema":{"name":"odds","schema":SCHEMA,"strict":True}}}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=60) as r: d=json.loads(r.read())
    return json.loads(d["choices"][0]["message"]["content"])["matches"][0]

cases = [
 ("WEAK: slight form edge only",
  "Arsenal(home) v Chelsea EPL. h2h 1.90/3.5/4.2 OU2.5 1.87/1.95. Form Arsenal WWDWD, Chelsea WDWLD. No injuries."),
 ("MODERATE: strong form gap, no injuries",
  "Arsenal(home) v Chelsea EPL. h2h 1.90/3.5/4.2 OU2.5 1.87/1.95. Form Arsenal WWWWW, Chelsea LLDLL. No injuries."),
 ("STRONG: form gap + key injury",
  "Arsenal(home) v Chelsea EPL. h2h 1.90/3.5/4.2 OU2.5 1.87/1.95. Form Arsenal WWWDW, Chelsea LDWLL. Chelsea first-choice striker OUT."),
 ("EXTREME: home collapse + 2 injuries vs hot away",
  "RealMadrid(home) v Sevilla LL. h2h 1.45/4.6/6.5 OU2.5 1.70/2.10. Form RM LLDLL, Sevilla WWWWW. RM star striker AND top defender OUT."),
 ("NONE: no evidence",
  "TeamA(home) v TeamB EPL. h2h 2.00/3.4/3.8 OU2.5 1.90/1.90. No form data. No injuries."),
]
print("Expect graduated magnitudes: weak~0.01-0.02, moderate~0.03-0.05, strong~0.06-0.08, extreme~0.10, none=0\n")
for label,txt in cases:
    m=call(txt)
    print("%-42s home=%+.3f draw=%+.3f away=%+.3f tot=%+.3f conf=%.2f %s"%(
        label,m["home_shift"],m["draw_shift"],m["away_shift"],m["totals_shift"],m["confidence"],m["adjustments"]))
