#!/bin/zsh
# Moves the second part of a long function (from a clean cut near <share> of
# its body to its end) into <function> in <target>:
#   split-function.sh <file> <function name in file> <target> <new function> [share]
set -e
f=$1; name=$2; target=$3; fn=$4; share=${5:-0.5}
line=$(grep -nE "^(export )?(default )?(async )?function ${name}\b|^(export )?const ${name} = " $f | head -1 | cut -d: -f1)
[ -n "$line" ] || { echo "no function $name in $f"; exit 1; }
range=$(node --import tsx scripts/pick-cut.mts $f $line $share)
node --import tsx scripts/extract-region.mts $f ${=range} $target $fn - 2>&1 | grep -E "^moved|Error"
node --import tsx scripts/prune-unused-imports.mts $f > /dev/null
npx prettier --write $f $target > /dev/null
