"""Generates web/src/lib/fixtures/testdata.json and supabase/seed.sql.

Synthetic data for the test profile ReLU NTNU (plus one unrelated profile, to
check that users never see it). Run: python3 scripts/make-testdata.py
"""

import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
random.seed(42)
NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)

RELU = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
USERS = [
    {"id": "aaaaaaaa-0000-4000-8000-000000000001", "email": "leon@example.com"},
    {"id": "aaaaaaaa-0000-4000-8000-000000000002", "email": "member@example.com"},
    {"id": "bbbbbbbb-0000-4000-8000-000000000003", "email": "outsider@example.com"},
]


def iso(d):
    return d.isoformat().replace("+00:00", "Z")


profiles = [
    {"id": RELU, "name": "ReLU NTNU", "website_url": "https://www.relu-ntnu.no",
     "social_links": ["https://www.instagram.com/relu_ntnu", "https://www.linkedin.com/company/relu-ntnu"],
     "created_at": iso(NOW - timedelta(days=3)), "backfill_status": "done",
     "last_web_search_at": iso(NOW - timedelta(hours=5))},
    {"id": OTHER, "name": "Other Org AS", "website_url": "https://other.example",
     "social_links": [], "created_at": iso(NOW - timedelta(days=10)), "backfill_status": "done",
     "last_web_search_at": None},
]
members = [
    {"profile_id": RELU, "user_id": USERS[0]["id"], "role": "owner", "joined_at": iso(NOW - timedelta(days=3))},
    {"profile_id": RELU, "user_id": USERS[1]["id"], "role": "member", "joined_at": iso(NOW - timedelta(days=2))},
    {"profile_id": OTHER, "user_id": USERS[2]["id"], "role": "owner", "joined_at": iso(NOW - timedelta(days=10))},
]
rules = [
    ("ReLU NTNU", [], False),
    ("ReLU", ["NTNU", "Trondheim", "studentorganisasjon", "student organization", "linjeforening"], False),
    ("activation function", [], True),
    ("aktiveringsfunksjon", [], True),
    ("leaky ReLU", [], True),
]
keyword_rules = [
    {"id": f"33333333-0000-4000-8000-00000000000{i}", "profile_id": RELU, "term": t,
     "context_terms": c, "is_exclusion": e, "created_at": iso(NOW - timedelta(days=3))}
    for i, (t, c, e) in enumerate(rules, start=1)
]
keyword_rules.append({"id": "33333333-0000-4000-8000-000000000009", "profile_id": OTHER,
                      "term": "Other Org", "context_terms": [], "is_exclusion": False,
                      "created_at": iso(NOW - timedelta(days=10))})

# (title, snippet, source_type, source_name, url, days_ago, reach)
base = [
    ("ReLU NTNU arrangerer AI-hackathon i Trondheim", "Over 150 studenter deltok da ReLU NTNU arrangerte sitt første hackathon.", "google_news", "universitetsavisa.no", "https://www.universitetsavisa.no/relu-hackathon", 1, 0.41),
    ("ReLU NTNU arrangerer AI-hackathon i Trondheim", "", "gdelt", "universitetsavisa.no", "https://www.universitetsavisa.no/relu-hackathon", 1, 0.41),
    ("Studentorganisasjonen ReLU vil ha flere kvinner inn i maskinlæring", "Studentorganisasjonen ved NTNU lanserer mentorprogram.", "google_news", "adressa.no", "https://www.adressa.no/nyheter/relu-kvinner-maskinlaering", 2, 0.66),
    ("NTNU-studenter vant nordisk AI-konkurranse med ReLU NTNU-lag", "Laget slo 40 andre universiteter.", "google_news", "nrk.no", "https://www.nrk.no/trondelag/ntnu-studenter-vant-ai", 5, 0.78),
    ("ReLU NTNU hosts Nordic student AI conference", "", "gdelt", "itavisen.no", "https://www.itavisen.no/2026/09/19/relu-ntnu-nordic-student-ai-conference", 4, 0.49),
    ("Trondheim-studenter i ReLU lanserer åpen kildekode-modell", "", "gdelt", "adressa.no", "https://www.adressa.no/nyheter/trondheim/relu-apen-kildekode-modell", 13, 0.66),
    ("Anyone joining ReLU NTNU's workshop on Thursday?", "Heard they are doing an intro to LLM fine-tuning. Is it beginner friendly?", "reddit", "r/ntnu", "https://www.reddit.com/r/ntnu/comments/1abc01/anyone_joining_relu_ntnus_workshop_on_thursday/", 1, 0.35),
    ("Studentforeningen ReLU på NTNU holder gratis AI-kurs for alle", "Åpent for alle i Trondheim, ikke bare studenter.", "reddit", "r/norge", "https://www.reddit.com/r/norge/comments/1abc03/studentforeningen_relu_pa_ntnu_holder_gratis/", 3, 0.58),
    ("Gratis AI-kurs for studenter denne helgen", "Påmelding her: https://www.relu-ntnu.no/events/ai-kurs-host-2026", "reddit", "r/trondheim", "https://www.reddit.com/r/trondheim/comments/1abc04/gratis_aikurs_for_studenter_denne_helgen/", 4, 0.22),
    ("ReLU NTNU – Student organization for AI at NTNU", "ReLU NTNU is a student organization in Trondheim that makes applied AI accessible to all students.", "web_search", "relu-ntnu.no", "https://www.relu-ntnu.no/about", 2, 0.05),
    ("Ti studentfrivillige som løfter Trondheim", "Blant dem finner vi AI-miljøet bak @relu_ntnu på Instagram.", "web_search", "nidaros.no", "https://www.nidaros.no/studentfrivillige-trondheim", 6, 0.12),
    ("Studentene som bygger norsk AI", "Linjeforeningen ReLU ved NTNU har vokst til over 400 medlemmer.", "web_search", "digi.no", "https://www.digi.no/artikler/studentene-som-bygger-norsk-ai/560123", 11, 0.52),
    ("ReLU NTNU starter opp: ny studentorganisasjon for kunstig intelligens", "En ny studentorganisasjon ved NTNU vil gjøre anvendt AI tilgjengelig for alle studenter.", "web_search", "universitetsavisa.no", "https://www.universitetsavisa.no/relu-ntnu-starter-opp", 597, 0.41),
]
# Older items spread over the last 90 days for the analytics charts.
older_titles = [
    "ReLU NTNU på stand under Teknologiporten", "Studentorganisasjonen ReLU inviterer til bedriftspresentasjon",
    "ReLU NTNU samarbeider med SINTEF om sommerjobber", "Hva gjør egentlig ReLU på NTNU?",
    "ReLU NTNU holds workshop on responsible AI", "ReLU-studenter i Trondheim bygger chatbot for Studentsamfundet",
    "ReLU NTNU søker nye styremedlemmer", "Nytt rekordopptak i ReLU NTNU",
]
sources = [("google_news", "universitetsavisa.no", 0.41), ("gdelt", "adressa.no", 0.66),
           ("reddit", "r/ntnu", 0.2), ("web_search", "digi.no", 0.52), ("google_news", "nrk.no", 0.78)]
for i, title in enumerate(older_titles):
    st, sn, reach = sources[i % len(sources)]
    base.append((title, "", st, sn, f"https://{sn if '.' in sn else 'www.reddit.com/' + sn}/sak-{i}",
                 15 + i * 9, round(max(0.0, min(1.0, reach + random.uniform(-0.1, 0.1))), 2)))

mentions = []
for i, (title, snippet, st, sn, url, days, reach) in enumerate(base, start=1):
    pub = NOW - timedelta(days=days, hours=random.randint(0, 20))
    mentions.append({
        "id": f"44444444-0000-4000-8000-{i:012d}", "profile_id": RELU, "url": url, "title": title,
        "snippet": snippet, "source_type": st, "source_name": sn, "published_at": iso(pub),
        "fetched_at": iso(min(NOW, pub + timedelta(hours=1))), "reach_score": reach,
        "sentiment": None, "sentiment_score": None, "confidence": None, "classifier_version": None,
        "hidden": False,
    })
# One item a member marked "Not relevant".
mentions.append({
    "id": "44444444-0000-4000-8000-000000000900", "profile_id": RELU,
    "url": "https://www.reddit.com/r/MachineLearning/comments/1abc09/relu_ntnu_course_notes/",
    "title": "ReLU notes from NTNU TDT4265 lecture", "snippet": "Lecture notes about ReLU and its variants.",
    "source_type": "reddit", "source_name": "r/MachineLearning", "published_at": iso(NOW - timedelta(days=7)),
    "fetched_at": iso(NOW - timedelta(days=7)), "reach_score": 0.71, "sentiment": None, "sentiment_score": None,
    "confidence": None, "classifier_version": None, "hidden": True,
})
mentions.append({
    "id": "44444444-0000-4000-8000-000000000999", "profile_id": OTHER, "url": "https://news.example/other-org",
    "title": "Other Org AS opens new office", "snippet": "Private to Other Org's members.",
    "source_type": "google_news", "source_name": "news.example", "published_at": iso(NOW - timedelta(days=1)),
    "fetched_at": iso(NOW - timedelta(days=1)), "reach_score": 0.3, "sentiment": None, "sentiment_score": None,
    "confidence": None, "classifier_version": None, "hidden": False,
})

runs = [
    {"id": "55555555-0000-4000-8000-000000000001", "kind": "hourly", "profile_id": None,
     "started_at": iso(NOW - timedelta(minutes=55)), "finished_at": iso(NOW - timedelta(minutes=53)),
     "status": "success", "stats": {"fetched": 84, "matched": 6, "inserted": 3,
     "per_source": {"google_news": 1, "gdelt": 1, "reddit": 1, "web_search": "skipped: not due"}}, "error": None},
    {"id": "55555555-0000-4000-8000-000000000002", "kind": "hourly", "profile_id": None,
     "started_at": iso(NOW - timedelta(hours=1, minutes=55)), "finished_at": iso(NOW - timedelta(hours=1, minutes=54)),
     "status": "failed", "stats": {"fetched": 12, "matched": 0, "inserted": 0},
     "error": "gdelt: HTTP 503 Service Unavailable"},
    {"id": "55555555-0000-4000-8000-000000000003", "kind": "backfill", "profile_id": RELU,
     "started_at": iso(NOW - timedelta(days=3)), "finished_at": iso(NOW - timedelta(days=3) + timedelta(minutes=2)),
     "status": "success", "stats": {"fetched": 310, "matched": 19, "inserted": 19}, "error": None},
    {"id": "55555555-0000-4000-8000-000000000004", "kind": "backfill", "profile_id": OTHER,
     "started_at": iso(NOW - timedelta(days=10)), "finished_at": iso(NOW - timedelta(days=10) + timedelta(minutes=1)),
     "status": "success", "stats": {"fetched": 20, "matched": 1, "inserted": 1}, "error": None},
]
quota_usage = [
    {"provider": "tavily", "month": "2026-09-01", "credits_used": 412},
    {"provider": "exa", "month": "2026-09-01", "credits_used": 0.0},
    {"provider": "serper", "month": "2026-09-01", "credits_used": 38},
]
invites = [
    {"id": "66666666-0000-4000-8000-000000000001", "profile_id": RELU, "token": "testinvitetoken0000000000000000000000000000000001",
     "created_by": USERS[0]["id"], "created_at": iso(NOW - timedelta(days=2)),
     "expires_at": iso(NOW + timedelta(days=5)), "used_at": None, "used_by": None},
]

data = {"now": iso(NOW), "users": USERS, "profiles": profiles, "profile_members": members,
        "keyword_rules": keyword_rules, "invites": invites, "mentions": mentions, "runs": runs,
        "quota_usage": quota_usage}
out = ROOT / "web/src/lib/fixtures/testdata.json"
out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def lit(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, list):
        return "array[" + ", ".join(lit(x) for x in v) + "]::text[]" if v else "'{}'::text[]"
    if isinstance(v, dict):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def inserts(table, rows):
    cols = list(rows[0].keys())
    lines = [f"insert into {table} ({', '.join(cols)}) values"]
    lines.append(",\n".join("  (" + ", ".join(lit(r[c]) for c in cols) + ")" for r in rows) + ";")
    return "\n".join(lines)


sql = [
    "-- Generated by scripts/make-testdata.py. Synthetic test data, do not edit by hand.",
    "-- Local test DB only; on a real Supabase project, users come from Auth instead.",
    "",
    inserts("auth.users", USERS),
]
for t in ("profiles", "profile_members", "keyword_rules", "invites", "mentions", "runs", "quota_usage"):
    sql.append(inserts(f"public.{t}", data[t]))
(ROOT / "supabase/seed.sql").write_text("\n\n".join(sql) + "\n", encoding="utf-8")
print(f"{len(mentions)} mentions written")
