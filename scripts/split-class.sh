#!/bin/zsh
# Moves class methods into <target>, first moving any top-level values they
# use into <file>-support.ts:  split-class.sh <file> <class> <target> <method…>
f=$1; c=$2; t=$3; shift 3
support=${f%.ts}-support.ts
for attempt in {1..20}; do
  out=$(node --import tsx scripts/extract-methods.mts $f $c $t "$@" 2>&1)
  if print -r -- "$out" | grep -q "^moved"; then
    print -r -- "$out" | grep "^moved" | cut -c1-160
    node --import tsx scripts/prune-unused-imports.mts $f $t > /dev/null
    npx prettier --write $f $t $(dirname $f)/install-methods.ts > /dev/null
    # The support module must not import values back from the class's file.
    while [ -f $support ]; do
      back=$(node --import tsx scripts/value-imports.mts $support $f)
      [ -n "$back" ] || break
      node --import tsx scripts/extract-declarations.mts $f $support ${=back} 2>&1 | grep -E "^moved|Error" | cut -c1-160
      npx prettier --write $f $support > /dev/null
    done
    exit 0
  fi
  names=$(print -r -- "$out" | sed -n 's/.*use \(.*\) from the source.*/\1/p' | tr -d ',')
  [ -n "$names" ] || { print -r -- "$out" | grep Error | head -2; exit 1; }
  node --import tsx scripts/extract-declarations.mts $f $support ${=names} 2>&1 | grep -E "^moved|Error" | cut -c1-160
  npx prettier --write $f $support > /dev/null
done
exit 1
