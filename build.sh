#!/bin/bash
set -e
OUT="Shopify Cycle Count.html"

{
  echo '<!doctype html>'
  echo '<html lang="en">'
  echo '<head>'
  echo '<meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width, initial-scale=1">'
  echo '<title>Shopify Cycle Count</title>'
  echo '<style>'
  cat src/style.css
  echo '</style>'
  echo '</head>'
  echo '<body>'
  echo '<div id="app"></div>'
  echo '<script>'
  cat vendor/papaparse.min.js
  echo '</script>'
  echo '<script>'
  cat vendor/xlsx.full.min.js
  echo '</script>'
  echo '<script>'
  cat src/app.js
  echo '</script>'
  echo '</body>'
  echo '</html>'
} > "$OUT"

wc -c "$OUT"
