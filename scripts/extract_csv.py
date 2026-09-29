import json
import os

transcript_path = r'C:\Users\u17da\.gemini\antigravity\brain\50563a92-51db-4afe-b0a2-3dccd3b7011c\.system_generated\logs\transcript.jsonl'
with open(transcript_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

user_input = ''
for line in reversed(lines):
    data = json.loads(line)
    if data.get('type') == 'USER_INPUT':
        c = data.get('content', '')
        if '学校コード,admin+ ID' in c:
            user_input = c
            break

print('Found length:', len(user_input))
os.makedirs('data', exist_ok=True)
with open('data/raw_excel_paste.txt', 'w', encoding='utf-8') as out:
    out.write(user_input)
print('Saved to data/raw_excel_paste.txt')
