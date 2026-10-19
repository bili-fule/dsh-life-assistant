"""Configure the actual Web standard preset, preserving native tools and YAML tags.

Run while DSH is stopped. No credentials or model window settings are modified.
"""
import argparse
import pathlib
import re

POLICY = '''auto: true
modelPolicies:
  - provider: xuanluo
    model: cn:deepseek-v4.1-flash
    thresholdRatio: 0.263
    headroomTokens: 65536
    retainTokens: 65536
    maxTokens: 8192
    compactionRetries: 2
    maxOverflowRetries: 2'''


def configure(preset, profile, policy=POLICY):
    # A profile row replaces the complete config. Preserve a user's existing
    # standard composition when present, otherwise copy the installed native one.
    existing = re.search(r'^- id: preset-standard\s*\n.*?(?=^- |\Z)', profile, re.M | re.S)
    if existing:
        row = existing.group()
    else:
        lines = preset.splitlines()
        start = next(i for i, line in enumerate(lines) if line == '      config:')
        row = '- id: preset-standard\n  config:\n' + '\n'.join(line[4:] if line.startswith('    ') else line for line in lines[start + 1:]) + '\n'
    lines = row.splitlines()
    start = next(i for i, line in enumerate(lines) if re.match(r'^\s*- id: compaction-basic\s*$', line))
    indent = len(lines[start]) - len(lines[start].lstrip())
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and not line.lstrip().startswith('#') and len(line) - len(line.lstrip()) <= indent:
            break
        end += 1
    prefix = ' ' * indent
    replacement = [prefix + '- id: compaction-basic', prefix + "  name: '@deepseek-ai/dsh-compaction-basic'", prefix + '  config:']
    replacement += [prefix + '    ' + line for line in policy.splitlines()]
    lines[start:end] = replacement
    updated = '\n'.join(lines).rstrip() + '\n'
    return profile[:existing.start()] + updated + '\n' + profile[existing.end():] if existing else profile.rstrip() + '\n\n' + updated


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--preset', required=True, type=pathlib.Path, help='Installed dsh-web-app/presets/standard.patch.yml')
    parser.add_argument('--profile', required=True, type=pathlib.Path, help='Profile cordis.patch.yml')
    args = parser.parse_args()
    original = args.profile.read_text(encoding='utf-8')
    updated = configure(args.preset.read_text(encoding='utf-8'), original)
    if original.rstrip() != updated.rstrip():
        backup = args.profile.with_name(args.profile.name + '.before-life-context')
        if not backup.exists():
            backup.write_text(original, encoding='utf-8')
            backup.chmod(0o600)
        args.profile.write_text(updated, encoding='utf-8')
        args.profile.chmod(0o600)
        print('Updated native standard preset: 263K trigger, model capacity unchanged.')
    else:
        print('Native standard preset already configured.')
