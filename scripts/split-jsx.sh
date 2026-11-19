#!/bin/zsh
# Moves each large leaf JSX block of <file> (scripts/jsx-blocks.mts) into a
# component file of its own next to it; undoes the file if tsc then fails.
#   split-jsx.sh <file> [min lines=80] [prefix]
f=$1; min=${2:-80}; prefix=$3
dir=$(dirname $f)
before=$(mktemp)
cp $f $before
made=()
shift_by=0
node --import tsx scripts/jsx-blocks.mts $f $min | while read line lines name; do
  # Each move adds one import line at the top of the file.
  line=$((line + shift_by))
  [ -n "$prefix" ] && [[ $name != ${prefix}* ]] && name="${prefix}${name}"
  target=$dir/$name.tsx
  [ -e $target ] && name="${name}Block" && target=$dir/$name.tsx
  out=$(node --import tsx scripts/extract-region.mts --jsx $f $line $target $name 2>&1)
  if print -r -- "$out" | grep -q "^moved"; then
    made+=($target); echo "  $name ($lines lines)"; shift_by=$((shift_by + 1))
  else
    print -r -- "$out" | grep Error | head -1
  fi
done
node --import tsx scripts/prune-unused-imports.mts $f > /dev/null
npx prettier --write $f $dir/*.tsx > /dev/null 2>&1
if npx tsc --noEmit -p . 2>&1 | grep -q "error TS"; then
  npx tsc --noEmit -p . 2>&1 | grep "error TS" | head -3
  echo "  undoing $f"
  cp $before $f
  git status --short $dir | awk '/^\?\?/{print $2}' | while read n; do case " ${made[*]} " in *" $n "*) rm -f $n;; esac; done
fi
rm -f $before
