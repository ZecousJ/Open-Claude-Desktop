#!/usr/bin/env python3
"""ZecousAI side of the move to Claudex (owner, 2026-10-03).

Runs on the ZecousAI host as the forced command of one SSH key that the
Claudex server holds (docs/zecous-migration.md). It understands two commands,
read from SSH_ORIGINAL_COMMAND (or argv when run by hand):

  quote <email>                 what the account is worth in Claudex, nothing changes
  confirm <email> <claudex-id>  clears the ZecousAI balance and subscriptions and
                                records the move; run again it answers with the
                                recorded amount and changes nothing

Prints one JSON object. Amounts are CNY, which Claudex credits 1:1 as USD.

The rules (owner):
  * The cut-off is 2026-09-04 00:00 China time (2026-09-03 16:00 UTC).
  * Balance: the balance on the cut-off day, with later usage given back
    (requests from then on are free) and later purchases kept; gifted credit
    (admin gifts, referral rewards) does not count. What remains, up to the
    credit the user ever paid for, is worth what the user paid for it on
    average (Y10 for $30 credit is Y10).
  * Subscriptions: each paid activation is worth what was paid for it, in
    proportion to the time it still had after the cut-off.
"""
import base64
import datetime as dt
import json
import os
import re
import subprocess
import sys
from decimal import Decimal, ROUND_HALF_UP

COMPOSE = "/opt/zecous-stack-compose.yml"
CONTAINER = "zecousai-mysql"
CUTOFF = dt.datetime(2026, 9, 3, 16, 0, 0)  # UTC
MIGRATION_EVENT = "claudex_migration"
PAID_SOURCES = ("zpay", "activation_code")
EMAIL = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}$")
ZERO = Decimal("0")


def fail(message, code=2):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def mysql_password():
    with open(COMPOSE, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*MYSQL_PASSWORD:\s*(.+?)\s*$", line)
            if m:
                return m.group(1).strip("\"'")
    fail("database settings not found", 3)


def run_sql(sql):
    """Runs SQL in one mysql session; returns rows (lists of strings) of every result."""
    env = dict(os.environ, MYSQL_PWD=mysql_password())
    proc = subprocess.run(
        ["docker", "exec", "-i", "-e", "MYSQL_PWD", CONTAINER,
         "mysql", "-uzecousai", "zecousai", "--batch", "--raw", "--skip-column-names",
         "--default-character-set=utf8mb4"],
        input=sql, capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, timeout=60,
    )
    if proc.returncode != 0:
        fail("database error: " + proc.stderr.strip().splitlines()[-1][:300] if proc.stderr.strip() else "database error", 3)
    return [line.split("\t") for line in proc.stdout.splitlines() if line]


def lit(value):
    """A MySQL string literal."""
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dec(value):
    try:
        return Decimal(value) if value not in (None, "", "NULL") else ZERO
    except Exception:
        return ZERO


def parse_extra(value):
    try:
        data = json.loads(base64.b64decode(value).decode("utf-8", "replace") or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def when(value):
    return dt.datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S") if value and value != "NULL" else None


def load(email):
    rows = run_sql(f"select id from identity_users where lower(email)=lower({lit(email)}) limit 1;")
    if not rows:
        return None
    uid = rows[0][0]
    balance = run_sql(f"select permanent_balance_usd from billing_account_balances where owner_id={lit(uid)};")
    # Usage rows are many: they are summed in the database; only purchases,
    # activations and a recorded move come back one by one.
    sums = run_sql(
        "select coalesce(sum(credits), 0), coalesce(sum(case when event_type='credit_recharge' "
        "and source in ('zpay','activation_code') then credits else 0 end), 0) "
        f"from billing_transactions where owner_id={lit(uid)} and created_at >= {lit(CUTOFF.strftime('%Y-%m-%d %H:%M:%S'))};")
    # extra travels as base64, so no tab or newline in it breaks the rows.
    txs = run_sql(
        "select event_type, source, amount_usd, credits, created_at, replace(to_base64(coalesce(cast(extra as char), '{}')), char(10), '') "
        f"from billing_transactions where owner_id={lit(uid)} and (event_type in ('credit_recharge', 'membership_activation', {lit(MIGRATION_EVENT)})) "
        "order by created_at, id;")
    subs = run_sql(
        "select plan_name, status, coalesce(membership_expires_at, period_end_at) "
        f"from identity_user_subscriptions where user_id={lit(uid)};")
    return {
        "uid": uid,
        "balance_row": bool(balance),
        "balance": dec(balance[0][0]) if balance else ZERO,
        "balance_raw": balance[0][0] if balance else None,
        "credits_after": dec(sums[0][0]) if sums else ZERO,
        "bought_after": dec(sums[0][1]) if sums else ZERO,
        "txs": [
            {"event": t[0], "source": t[1], "amount": dec(t[2]), "credits": dec(t[3]),
             "at": when(t[4]), "extra": parse_extra(t[5])}
            for t in txs
        ],
        "subs": [{"plan": s[0], "status": s[1], "end": when(s[2])} for s in subs],
    }


def recorded(account):
    for t in account["txs"]:
        if t["event"] == MIGRATION_EVENT:
            return t["extra"]
    return None


def worth(account):
    balance_at_cutoff = account["balance"] - account["credits_after"]
    bought_after = account["bought_after"]
    remaining = max(ZERO, balance_at_cutoff + bought_after)

    paid_credits = paid_cny = ZERO
    for t in account["txs"]:
        if t["event"] != "credit_recharge" or t["source"] not in PAID_SOURCES or t["credits"] <= 0:
            continue
        cny = dec(t["extra"].get("paidAmountCny")) if t["source"] == "zpay" else t["amount"]
        paid_credits += t["credits"]
        paid_cny += cny
    paid_remaining = min(remaining, paid_credits)
    balance_cny = paid_remaining * paid_cny / paid_credits if paid_credits > 0 else ZERO

    # Paid activations, each lasting durationDays from when the previous one ran out.
    sub_end = max((s["end"] for s in account["subs"] if s["plan"] != "Free" and s["end"]), default=None)
    cursor = None
    subscription_cny = ZERO
    lines = []
    for t in account["txs"]:
        if t["event"] != "membership_activation" or t["source"] not in PAID_SOURCES or t["amount"] <= 0:
            continue
        days = dec(t["extra"].get("durationDays")) or Decimal(30)
        start = max(t["at"], cursor) if cursor else t["at"]
        end = start + dt.timedelta(days=float(days))
        cursor = end
        if sub_end:
            end = min(end, sub_end)
        left = (end - max(start, CUTOFF)).total_seconds()
        total = float(days) * 86400
        if left <= 0 or total <= 0:
            continue
        value = t["amount"] * Decimal(left / total)
        subscription_cny += value
        lines.append({
            "plan": t["extra"].get("activatedPlanName") or t["extra"].get("paidPlanName") or "",
            "paid_cny": str(t["amount"]),
            "days_left": round(left / 86400, 1),
            "worth_cny": str(value.quantize(Decimal("0.01"), ROUND_HALF_UP)),
        })

    cents = Decimal("0.01")
    balance_cny = balance_cny.quantize(cents, ROUND_HALF_UP)
    subscription_cny = subscription_cny.quantize(cents, ROUND_HALF_UP)
    return {
        "balance_cny": str(balance_cny),
        "subscription_cny": str(subscription_cny),
        "total_cny": str(balance_cny + subscription_cny),
        "subscriptions": lines,
        "balance_credits_at_cutoff": str(remaining.quantize(cents, ROUND_HALF_UP)),
        "paid_credits": str(paid_credits.quantize(cents, ROUND_HALF_UP)),
    }


def quote(email):
    account = load(email)
    if not account:
        return {"ok": True, "found": False}
    done = recorded(account)
    if done:
        return {"ok": True, "found": True, "migrated": True, **{k: done.get(k) for k in ("total_cny", "balance_cny", "subscription_cny", "claudex_user_id", "subscriptions")}}
    return {"ok": True, "found": True, "migrated": False, **worth(account)}


def confirm(email, claudex_user_id):
    if not re.fullmatch(r"\d{1,18}", claudex_user_id):
        fail("bad Claudex user id")
    for _ in range(3):
        account = load(email)
        if not account:
            return {"ok": True, "found": False}
        done = recorded(account)
        if done:
            return {"ok": True, "found": True, "migrated": True, "already": True, **{k: done.get(k) for k in ("total_cny", "balance_cny", "subscription_cny", "claudex_user_id", "subscriptions")}}
        value = worth(account)
        extra = json.dumps({**value, "claudex_user_id": claudex_user_id, "email": email.lower()}, ensure_ascii=False)
        uid = lit(account["uid"])
        # Only when nothing changed since the account was read: the balance is
        # the one read (or there is no balance row) and no move is recorded.
        if account["balance_row"]:
            guard = (f"update billing_account_balances set permanent_balance_usd=0, updated_at=utc_timestamp() "
                     f"where owner_id={uid} and permanent_balance_usd={account['balance_raw']} and @done=0;\n"
                     "set @ok = (row_count() = 1);\n")
        else:
            guard = ("set @ok = (@done = 0 and (select count(*) from billing_account_balances "
                     f"where owner_id={uid}) = 0);\n")
        sql = (
            "start transaction;\n"
            f"select count(*) into @done from billing_transactions where owner_id={uid} and event_type={lit(MIGRATION_EVENT)} for update;\n"
            + guard +
            # Membership ends now; ZecousAI itself then moves the subscription
            # back to its free plan (identity/service.py, an expired membership).
            f"update identity_user_subscriptions set membership_expires_at=utc_timestamp(), "
            f"period_end_at=least(coalesce(period_end_at, utc_timestamp()), utc_timestamp()), updated_at=utc_timestamp() "
            f"where user_id={uid} and @ok and coalesce(membership_expires_at, period_end_at) > utc_timestamp();\n"
            "insert into billing_transactions (id, owner_id, event_type, source, title, amount_usd, currency, credits, extra, created_at) "
            f"select uuid(), {uid}, {lit(MIGRATION_EVENT)}, 'claudex', 'Moved to Claudex', {value['total_cny']}, 'CNY', "
            f"{-account['balance']}, {lit(extra)}, utc_timestamp() from dual where @ok;\n"
            "select if(@ok, 'ok', 'retry');\n"
            "commit;\n"
        )
        result = run_sql(sql)
        if result and result[-1][0] == "ok":
            return {"ok": True, "found": True, "migrated": True, "already": False, **value, "claudex_user_id": claudex_user_id}
    fail("the account kept changing; try again", 4)


def main():
    raw = os.environ.get("SSH_ORIGINAL_COMMAND") or " ".join(sys.argv[1:])
    parts = raw.split()
    if len(parts) >= 2 and parts[0] in ("quote", "confirm") and EMAIL.match(parts[1]):
        if parts[0] == "quote" and len(parts) == 2:
            print(json.dumps(quote(parts[1]), ensure_ascii=False))
            return
        if parts[0] == "confirm" and len(parts) == 3:
            print(json.dumps(confirm(parts[1], parts[2]), ensure_ascii=False))
            return
    fail("usage: quote <email> | confirm <email> <claudex-user-id>")


if __name__ == "__main__":
    main()
