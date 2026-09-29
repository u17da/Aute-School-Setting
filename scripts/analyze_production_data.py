import sys
import io
import re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('data/production_grades_classes_raw.csv', 'r', encoding='utf-8') as f:
    lines = [l.strip() for l in f if l.strip()]

print(f"Total non-empty lines: {len(lines)}")
header_line_idx = -1
for i, l in enumerate(lines[:10]):
    if '学校コード' in l or 'SchoolID' in l:
        header_line_idx = i
        break

print(f"Header found at line {header_line_idx}: {lines[header_line_idx]}")
header = lines[header_line_idx].split(',')

target_schools = []
trailing_schools = []

for idx, line in enumerate(lines[header_line_idx + 1:], start=header_line_idx + 2):
    parts = [p.strip() for p in line.split(',')]
    if len(parts) >= 6:
        target_schools.append((idx, parts))
    elif len(parts) == 4:
        trailing_schools.append((idx, parts))

print(f"6+ columns (学年・クラス設定対象校): {len(target_schools)} 校")
print(f"4 columns (管理者設定用リスト?): {len(trailing_schools)} 校")

# 特殊トークン調査
non_single_alphanumeric = set()
schools_with_nan = []
schools_with_all_blank = []

for idx, parts in target_schools:
    code, name, uid, pw = parts[0], parts[1], parts[2], parts[3]
    years = parts[4] if len(parts) > 4 else ''
    classes = parts[5] if len(parts) > 5 else ''

    if code == 'NaN' or uid == 'NaN':
        schools_with_nan.append((idx, name, code))

    if years in ['（空欄）', '(空欄)', '空欄', ''] and classes in ['（空欄）：（空欄）', '(空欄):(空欄)', '']:
        schools_with_all_blank.append((idx, name, code))

    # クラスのトークン
    for b in re.split(r'[｜|]', classes):
        b = b.strip()
        if not b or b in ['（空欄）：（空欄）', '(空欄):(空欄)']: continue
        if '：' in b:
            g, c_str = b.split('：', 1)
        elif ':' in b:
            g, c_str = b.split(':', 1)
        else:
            continue
        g = g.strip()
        if g in ['（空欄）', '(空欄)', '空欄', '']: continue
        for c in re.split(r'[,、]', c_str):
            c = c.strip()
            if not c or c in ['（空欄）', '(空欄)', '空欄']: continue
            if not re.match(r'^[0-9０-９A-Za-zＡ-Ｚａ-ｚ]$', c):
                non_single_alphanumeric.add(c)

print("\n--- 特殊なトークン一覧（数字/英字1文字以外） ---")
for t in sorted(list(non_single_alphanumeric)):
    print(f"  - '{t}'")

print(f"\n--- NaNを含む学校 ({len(schools_with_nan)}校) ---")
for s in schools_with_nan:
    print(f"  Line {s[0]}: {s[1]} (コード: {s[2]})")

print(f"\n--- 学年・クラスがすべて空欄の学校 ({len(schools_with_all_blank)}校) ---")
for s in schools_with_all_blank:
    print(f"  Line {s[0]}: {s[1]} (コード: {s[2]})")
