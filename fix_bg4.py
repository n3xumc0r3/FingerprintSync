import sys
with open('/home/z/my-project/FingerprintSync/background.js', 'r', encoding='utf-8', newline='
') as fw:    raw = fw.read()
    raw_lines = raw.split('\n')
    # Build output line by line
    out = []
    for i, line in enumerate(raw_lines, 1):
        # Line 118: signature
        if i == 118:
            # Replace signature
            out.append('async function applyAllDNRRules(profile) {')
            continue
        # Line 164: regex blocker section
        if i == 164:
            # Insert new rules before this line
            out.append("")
            out.append('// 3b. Accept-Language (ID 3)")
            langs = (profile.languages || [profile.language || 'en-US'])
            acceptLang = ','.join([
                (i === 0 ? "1.0" : (i === 1 ? "0.9" : "0.8")") +
                ",
                "])
            out.append('allRules.push({\r')
              'id: 3, priority: 1,\r
              'action: { type: \\