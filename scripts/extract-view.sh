#!/bin/zsh
# Moves a component's main `return (…);` or `return createPortal(…);`
# (starting at <line>) into a function of its own:
#   extract-view.sh <file> <line> <target> <function>
set -e
f=$1; start=$2; target=$3; fn=$4
end=$(awk -v s=$start 'NR>s && /^  \);$/{print NR; exit}' $f)
[ -n "$end" ] || { echo "no closing ); after line $start"; exit 1; }
sed -n "${start}p" $f | grep -q '^  return [a-zA-Z(]' || { echo "line $start is not '  return …('"; exit 1; }
sed -i '' "${start}s/^  return /  const ${fn}View = /; ${end}s/^  );\$/  );\\
  return ${fn}View;/" $f
node --import tsx scripts/extract-region.mts $f $start $end $target $fn ${fn}View
node --import tsx scripts/prune-unused-imports.mts $f > /dev/null
npx prettier --write $f $target > /dev/null
