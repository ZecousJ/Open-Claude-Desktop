#!/usr/bin/env python3
"""Reassemble the official Claude Android 1.261111.19 split APKs for local use."""

import argparse
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


def run(*command):
    subprocess.run(command, check=True)


def prepare_resources(decoded):
    resources = decoded / "res"
    public = (resources / "values/public.xml").read_text()
    names = dict(
        (name, "inline" + name[1:]) for name in re.findall(r'name="(\$[^"]+)"', public)
    )
    if len(names) != 7:
        raise ValueError("Expected the seven inline resource names from the pinned decode")
    for entry in resources.glob("*/*.xml"):
        if entry.stem in names:
            renamed = entry.with_name(names[entry.stem] + ".xml")
            entry.rename(renamed)
            entry = renamed
        original = entry.read_text()
        updated = original
        for name, replacement in names.items():
            updated = updated.replace(name, replacement)
        if updated != original:
            entry.write_text(updated)


def set_loopback(decoded, port):
    client = decoded / "smali/bf1.smali"
    text = client.read_text()
    endpoint = '"https://claude.ai"'
    if text.count(endpoint) != 1:
        raise ValueError("Expected one native API base URL in bf1.smali")
    client.write_text(text.replace(endpoint, f'"http://127.0.0.1:{port}"'))
    authorization = decoded / "smali/lr4.smali"
    text = authorization.read_text()
    same_origin = """    invoke-static {p1, p2}, Lax0;->o(Lhfn;Lhfn;)Z

    move-result p0"""
    if text.count(same_origin) != 1:
        raise ValueError("Expected the native Connect same-origin credential check")
    text = text.replace(".method public static final b(Ljava/lang/String;Lhfn;Lhfn;)Z\n    .locals 0",
                        ".method public static final b(Ljava/lang/String;Lhfn;Lhfn;)Z\n    .locals 2")
    authorization.write_text(text.replace(same_origin, f"""    invoke-static {{p1, p2}}, Lax0;->o(Lhfn;Lhfn;)Z

    move-result p0

    if-nez p0, :claudex_connect_origin

    const-string v0, "http://127.0.0.1:{port}/"

    iget-object v1, p1, Lhfn;->i:Ljava/lang/String;

    invoke-virtual {{v1, v0}}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result p0

    if-eqz p0, :claudex_connect_origin

    iget-object v1, p2, Lhfn;->i:Ljava/lang/String;

    invoke-virtual {{v0, v1}}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z

    move-result p0

    :claudex_connect_origin"""))
    policy = decoded / "res/xml/APKTOOL_RENAMED_0x7f17000b.xml"
    closing = "</network-security-config>"
    text = policy.read_text()
    policy.write_text(text.replace(
        closing,
        '    <domain-config cleartextTrafficPermitted="true">\n'
        "        <domain>127.0.0.1</domain>\n"
        "    </domain-config>\n" + closing,
    ))
    text_picker = decoded / "smali_classes3/pj0.smali"
    text = text_picker.read_text()
    read_text = """    :try_start_8
    invoke-virtual {v2, v1}, Lpc6;->G(Leta0;)J

    invoke-virtual {v2}, Lpc6;->c1()Ljava/lang/String;

    move-result-object v3
    :try_end_8"""
    if text.count(read_text) != 1:
        raise ValueError("Expected one local attachment text read in pj0.invokeSuspend")
    text_picker.write_text(text.replace(read_text, """    :try_start_8
    invoke-virtual {v2, v1}, Lpc6;->G(Leta0;)J

    iget-wide v3, v2, Lpc6;->b:J

    invoke-virtual {v2, v3, v4}, Lpc6;->S(J)[B

    move-result-object v3

    const/4 v4, 0x0

    const/4 v5, 0x3

    invoke-static {v4, v4, v5, v3}, Ly1c0;->f0(III[B)Ljava/lang/String;

    move-result-object v3
    :try_end_8"""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original_apks", type=Path)
    parser.add_argument("decoded_base", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--apktool", type=Path, required=True)
    parser.add_argument("--build-tools", type=Path, required=True)
    parser.add_argument("--debug-keystore", type=Path, default=Path.home() / ".android/debug.keystore")
    parser.add_argument("--loopback-port", type=int, choices=range(1024, 65536), metavar="PORT")
    args = parser.parse_args()

    metadata = (args.decoded_base / "apktool.yml").read_text()
    if not re.search(r"(?m)^  versionCode: 26111119$", metadata):
        parser.error("Expected the Apktool 3.0.3 decode of version 1.261111.19")
    split_names = (
        "split_config.arm64_v8a.apk",
        "split_config.fr.apk",
        "split_config.xxxhdpi.apk",
        "split_config.zh.apk",
    )
    for name in ("base.apk", *split_names):
        if not (args.original_apks / name).is_file():
            parser.error(f"Missing original APK {name}")
    if args.output.exists():
        parser.error("Choose a new output directory")

    with tempfile.TemporaryDirectory(prefix="claudex-official-android-") as work:
        scratch = Path(work)
        decoded = scratch / "decoded"
        shutil.copytree(args.decoded_base, decoded, ignore=shutil.ignore_patterns("build", "dist"))
        prepare_resources(decoded)
        if args.loopback_port:
            set_loopback(decoded, args.loopback_port)
        base = scratch / "base.apk"
        run(args.apktool, "b", "-j", "6", decoded, "-o", base)
        with zipfile.ZipFile(base) as archive:
            dex = {name for name in archive.namelist() if re.fullmatch(r"classes\d*\.dex", name)}
        if dex != {"classes.dex", *(f"classes{n}.dex" for n in range(2, 7))}:
            raise ValueError("Rebuilt base must contain all six DEX files")

        tools = args.build_tools
        signed = scratch / "signed"
        signed.mkdir()
        for apk in (base, *(args.original_apks / name for name in split_names)):
            aligned = scratch / "aligned.apk"
            target = signed / apk.name
            run(tools / "zipalign", "-P", "16", "-f", "4", apk, aligned)
            run(
                tools / "apksigner", "sign", "--ks", args.debug_keystore,
                "--ks-pass", "pass:android", "--ks-key-alias", "androiddebugkey",
                "--key-pass", "pass:android", "--v4-signing-enabled", "false",
                "--out", target, aligned,
            )
            run(tools / "apksigner", "verify", target)
        shutil.copytree(signed, args.output)


if __name__ == "__main__":
    main()
