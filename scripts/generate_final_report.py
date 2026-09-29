import csv
import glob
import json
import os

clean_csv_path = r"data/all_school_admins_clean.csv"
reports_pattern = r"reports/admin_register_report_*.json"
output_csv_path = r"reports/FINAL_ALL_SCHOOL_ADMINS_COMPLETED.csv"
output_summary_path = r"reports/FINAL_EXECUTION_SUMMARY.json"

# 1. Load clean CSV
clean_records = []
header = None
with open(clean_csv_path, mode="r", encoding="utf-8-sig") as f:
    reader = csv.reader(f)
    header = next(reader)
    for row in reader:
        if len(row) >= 9 and row[0].strip() and row[8].strip():
            clean_records.append(row)

print(f"Loaded {len(clean_records)} clean records from {clean_csv_path}")

# 2. Load all report files in chronological order
report_files = sorted(glob.glob(reports_pattern))
print(f"Found {len(report_files)} report files")

# Map: (schoolCode, userId) -> result record
latest_results = {}

for rf in report_files:
    try:
        with open(rf, mode="r", encoding="utf-8") as f:
            data = json.load(f)
            results = data if isinstance(data, list) else data.get("results", [])
            for res in results:
                sc = str(res.get("schoolCode", "")).strip()
                uid = str(res.get("userId") or res.get("login_name", "")).strip()
                if sc and uid:
                    latest_results[(sc, uid)] = res
    except Exception as e:
        print(f"Error reading {rf}: {e}")

print(f"Aggregated {len(latest_results)} unique executed admin records")

# 3. Merge with clean records
final_rows = []
status_counts = {}

for row in clean_records:
    sc = row[0].strip()
    uid = row[8].strip()
    res = latest_results.get((sc, uid))
    
    out_row = list(row)
    if res:
        st = res.get("status", "UNKNOWN")
        msg = res.get("message", "")
        sp = res.get("screenshotPath", "")
        ts = res.get("timestamp", "")
    else:
        st = "NOT_EXECUTED"
        msg = "No report entry found"
        sp = ""
        ts = ""
    
    out_row.extend([st, msg, sp, ts])
    status_counts[st] = status_counts.get(st, 0) + 1
    final_rows.append(out_row)

# 4. Write final completed CSV
new_header = list(header) + [
    "実行ステータス",
    "実行メッセージ",
    "スクリーンショットパス",
    "実行日時"
]

with open(output_csv_path, mode="w", encoding="utf-8-sig", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(new_header)
    writer.writerows(final_rows)

print(f"Successfully generated {output_csv_path}")
print("Status Counts:", json.dumps(status_counts, ensure_ascii=False, indent=2))

# 5. Write summary json
with open(output_summary_path, mode="w", encoding="utf-8") as f:
    json.dump({
        "total_records": len(final_rows),
        "status_counts": status_counts,
        "is_all_success_or_skipped": (
            status_counts.get("NOT_EXECUTED", 0) == 0 and 
            status_counts.get("ERROR", 0) == 0
        )
    }, f, ensure_ascii=False, indent=2)
