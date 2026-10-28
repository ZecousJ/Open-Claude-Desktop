#!/usr/bin/env bash
# SDK-free Kotlin/core + native transport checks. Dependencies: Java 17+, Python 3, curl.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${CLAUDEX_TEST_CACHE:-${TMPDIR:-/tmp}/claudex-android-jvm-check}"
mkdir -p "$CACHE/jars" "$CACHE/classes"
python3 - "$CACHE/jars" "$ROOT/scripts/jvm-dependencies.tsv" <<'PY'
from concurrent.futures import ThreadPoolExecutor
import hashlib, pathlib, subprocess, sys
folder=pathlib.Path(sys.argv[1]); entries=[line.strip().split('\t') for line in pathlib.Path(sys.argv[2]).read_text().splitlines() if line and not line.startswith('#')]
def get(entry):
    group,artifact,version,expected=entry; target=folder/(artifact+'.jar')
    if not target.exists():
        url='https://repo.maven.apache.org/maven2/'+group.replace('.','/')+'/'+artifact+'/'+version+'/'+artifact+'-'+version+'.jar'
        subprocess.run(['curl','--fail','--location','--retry','2','--max-time','180','--output',str(target),url],check=True)
    actual=hashlib.sha256(target.read_bytes()).hexdigest()
    if actual != expected: raise SystemExit('Checksum mismatch: '+artifact)
with ThreadPoolExecutor(max_workers=6) as pool: list(pool.map(get,entries))
PY
CP="$(find "$CACHE/jars" -name '*.jar' -print | paste -sd: -)"
CORE=()
while IFS= read -r source; do
    CORE+=("$source")
done < <(find "$ROOT/core/src" -name '*.kt' -print)
java -cp "$CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath "$CP" -d "$CACHE/classes" "${CORE[@]}" "$ROOT/app/src/main/java/com/claudex/mobile/ConversationBridgePolicy.kt" "$ROOT/app/src/main/java/com/claudex/mobile/ConversationDelivery.kt" "$ROOT/app/src/main/java/com/claudex/mobile/DiffPresentation.kt" "$ROOT/app/src/main/java/com/claudex/mobile/WireCodec.kt" "$ROOT/app/src/main/java/com/claudex/mobile/NativeApi.kt" "$ROOT/app/src/main/java/com/claudex/mobile/RemoteRepository.kt" "$ROOT/app/src/test/java/com/claudex/mobile/NativeApiTest.kt" "$ROOT/app/src/test/java/com/claudex/mobile/ConversationHydrationTest.kt" "$ROOT/app/src/test/java/com/claudex/mobile/DiffPresentationTest.kt" "$ROOT/app/src/test/java/com/claudex/mobile/ChatContractsTest.kt" "$ROOT/app/src/test/java/com/claudex/mobile/SharedConversationContractsTest.kt"
java -cp "$CACHE/classes:$CP" org.junit.runner.JUnitCore com.claudex.core.CoreTest com.claudex.core.ChatFoundationsTest com.claudex.mobile.ChatContractsTest com.claudex.mobile.NativeApiTest com.claudex.mobile.ConversationHydrationTest com.claudex.mobile.DiffPresentationTest com.claudex.mobile.SharedConversationContractsTest
