#!/usr/bin/env python3
"""Import the Claude Android 1.261111.19 greeting and composer resources."""
import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile
from hashlib import sha256

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("apk_directory", type=Path)
parser.add_argument("recovered_source", type=Path)
parser.add_argument("--android", type=Path, required=True, help="mobile/android directory")
parser.add_argument("--ios", type=Path, required=True, help="mobile/ios directory")
args = parser.parse_args()
evidence = json.loads((args.recovered_source / "analysis/rea-package.json").read_text())
meta = evidence["normalized_result"]
apk_path = args.apk_directory / "base.apk"
if sha256(apk_path.read_bytes()).hexdigest() != evidence["subject"]["digest"]["sha256"]:
    parser.error("APK differs from the REA source evidence")
if (meta["package_name"], meta["version_name"], str(meta["version_code"])) != (
    "com.anthropic.claude", "1.261111.19", "26111119"
):
    parser.error("Expected Claude Android 1.261111.19 (26111119)")

# The first resource of each p1n enum case is the branded hold-to-talk hint.
enum = (args.recovered_source / "java/sources/p000/p1n.java").read_text()
ids = {"chat_headline_today": "0x7f1409a2"}
for case, key in (("NewConversation", "chat_input_hold_to_talk_new"), ("Reply", "chat_input_hold_to_talk_reply")):
    match = re.search(rf"{case}\(C3149R.string._0_resource_name_obfuscated_res_(0x[0-9a-f]+)", enum)
    if not match:
        parser.error(f"Could not read the {case} resource from p1n")
    ids[key] = match[1]

for android_locale, ios_locale, relative in (
    ("values", "en", "base/res/values/strings.xml"),
    ("values-zh-rCN", "zh-Hans", "split_config.zh/res/values-b+zh+Hans/strings.xml"),
):
    catalog = ET.parse(args.recovered_source / "decoded" / relative).getroot()
    values = {
        key: catalog.find(f"string[@name='APKTOOL_RENAMED_{resource}']").text.replace("Claude", "Claudex")
        for key, resource in ids.items()
    }
    directory = args.android / "app/src/main/res" / android_locale
    greeting = directory / "strings.xml"
    old = greeting.read_text()
    old, count = re.subn(r'(<string name="chat_headline_today">).*?(</string>)',
                         lambda m: m[1] + values["chat_headline_today"] + m[2], old)
    if count != 1:
        parser.error(f"Expected one greeting in {greeting}")
    greeting.write_text(old)
    hints = ET.Element("resources")
    for key, value in values.items():
        if key != "chat_headline_today":
            ET.SubElement(hints, "string", name=key).text = value
    ET.indent(hints, space="    ")
    (directory / "strings_official_composer.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(hints, encoding="unicode") + "\n"
    )
    strings = args.ios / "Claudex/Resources/Strings" / (ios_locale + ".strings")
    body = strings.read_text()
    for key, value in values.items():
        entry = f'"{key}" = {json.dumps(value, ensure_ascii=False)};'
        body, count = re.subn(rf'^"{key}" = .*?;$', lambda _: entry, body, flags=re.M)
        if not count:
            body += entry + "\n"
    strings.write_text(body)

with zipfile.ZipFile(apk_path) as apk:
    for family in ("sans", "serif"):
        name = f"anthropic_{family}.ttf"
        member = "assets/composeResources/claude.theme.generated.resources/font/" + name
        data = apk.read(member)
        if data != (args.recovered_source / "decoded/base" / member).read_bytes():
            parser.error(f"Recovered font differs from {member}")
        android_fonts = args.android / "app/src/main/res/font"
        android_fonts.mkdir(exist_ok=True)
        (android_fonts / name).write_bytes(data)
        (args.ios / "Claudex/Resources/Fonts" / name).write_bytes(data)
