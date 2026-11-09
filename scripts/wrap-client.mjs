#!/usr/bin/env node
/**
 * Post-process a tsdown ESM client bundle into the DSH __ModuleLoader__ format.
 *
 * The DSH browser loader expects:
 *   window.__ModuleLoader__.load({ id: "...", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     // ... transformed bundle body ...
 *     return module.exports;
 *   }});
 *
 * tsdown's iife banner/footer cannot achieve this cleanly because:
 *   1. External imports (react, etc.) become bare identifiers in the IIFE params
 *      that the loader never fills.
 *   2. The `intro` option is unreliable with tsdown's output pipeline.
 *   3. ESM `export { X }` statements survive into the output.
 *
 * This script transforms the ESM output directly:
 *   - `import { X, Y } from 'pkg'` → `var { X, Y } = require('pkg');`
 *   - `import DefaultExport from 'pkg'` → `var DefaultExport = require('pkg');`
 *   - `import Default, { X } from 'pkg'` → `var Default = require('pkg'); var { X } = Default;`
 *   - `import * as NS from 'pkg'` → `var NS = require('pkg');`
 *   - `export { X, Y }` → `exports.X = X; exports.Y = Y;`
 *   - `export { X as Y }` → `exports.Y = X;`
 *   - Wraps everything in the ModuleLoader factory shell.
 *
 * The module specifier decides which `require` key is used:
 *   - a platform seed word (`react`, `react/jsx-runtime`,
 *     `@deepseek-ai/dsh-client-ui-primitives`) is required verbatim, because the
 *     loader's seed table is keyed by those exact ids;
 *   - a package root (`pkg/sub` → `pkg`) is required by root, because the client
 *     transport registers packages under their root id.
 *
 * A leftover `import`/`export` must fail the build: the DSH loader evaluates this
 * file as a classic script, so any surviving ESM syntax is a SyntaxError that
 * takes down the whole entry — silently shipping a bundle that cannot register.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { argv } from 'node:process'

const [,, inputFile, packageId] = argv
if (!inputFile || !packageId) {
  console.error('Usage: wrap-client.mjs <input.js> <package-id>')
  process.exit(1)
}

const filePath = resolve(inputFile)
let code = readFileSync(filePath, 'utf8')

/** Platform seed words the loader's module table answers verbatim. Everything else is required by package root. */
const SEED_WORDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** The key a `require` must use for one import specifier: seed words verbatim, other subpaths by package root. */
function requireKey(spec) {
  if (SEED_WORDS.has(spec) || !spec.includes('/')) return spec
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

/** `X, Y as Z` → `X, Z: Y`, the destructuring form for one named-import list. */
function toBindings(names) {
  return names.split(',').map(n => {
    const [orig, alias] = n.trim().split(/\s+as\s+/)
    return alias ? `${alias.trim()}: ${orig.trim()}` : orig.trim()
  }).filter(Boolean).join(', ')
}

/** Rewrite one import clause as a `require`, binding a default import through a temporary. */
function toRequire(defaultName, names, pkg) {
  const key = requireKey(pkg)
  if (defaultName === undefined) {
    if (names === undefined) return `require(${JSON.stringify(key)});`
    return `var { ${toBindings(names)} } = require(${JSON.stringify(key)});`
  }
  if (names === undefined) return `var ${defaultName} = require(${JSON.stringify(key)});`
  const temp = `__default_${defaultName}`
  return `var ${temp} = require(${JSON.stringify(key)});`
    + `\nvar ${defaultName} = ${temp};`
    + `\nvar { ${toBindings(names)} } = ${temp};`
}

// 1. Rewrite every import form:
//      import { X, Y as Z } from 'pkg'
//      import X from 'pkg'
//      import X, { Y } from 'pkg'   ← the combined form tsdown emits for React
//      import * as NS from 'pkg'
//    The combined form is listed first: the default-only rule below would
//    otherwise leave `import React, { useState } from "react"` untouched, and a
//    surviving `import` in a classic-script bundle is a SyntaxError that stops
//    the whole entry from registering.
code = code.replace(
  /^[ \t]*import\s+(?:(\w+)\s*,\s*\{([^}]*)\}|\{([^}]*)\}|\*\s*as\s+(\w+)|(\w+))\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm,
  (_match, combinedDefault, combinedNames, bareNames, namespace, bareDefault, pkg) => {
    if (namespace !== undefined) return `var ${namespace} = require(${JSON.stringify(requireKey(pkg))});`
    if (combinedDefault !== undefined) return toRequire(combinedDefault, combinedNames, pkg)
    if (bareNames !== undefined) return toRequire(undefined, bareNames, pkg)
    return toRequire(bareDefault, undefined, pkg)
  }
)

// 2. Rewrite named exports: export { X, Y as Z }
code = code.replace(
  /^export\s*\{([^}]+)\}\s*;?\s*$/gm,
  (_match, names) => {
    return names.split(',').map(n => {
      const [orig, alias] = n.trim().split(/\s+as\s+/)
      const exportedName = alias ? alias.trim() : orig.trim()
      const localName = orig.trim()
      return `exports.${exportedName} = ${localName};`
    }).filter(line => line.trim() !== 'exports. = ;').join('\n')
  }
)

// 3. Refuse to write a bundle the loader cannot evaluate. The DSH transport serves
//    this file as a classic script, so one leftover ESM statement is a SyntaxError
//    reported to the person as "entry did not activate" with no clue which build step
//    produced it. Fail here instead, naming the offending line.
const leftover = code.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /^\s*(?:import\s*[({'*"a-zA-Z]|export\s+(?:default|\{|const|let|var|function|class|async))/m.test(line))
if (leftover.length > 0) {
  const report = leftover.map(({ line, number }) => `  ${number}: ${line.trim()}`).join('\n')
  throw new Error(
    `wrap-client: ${inputFile} still carries ESM syntax after transformation;`
    + ` the DSH loader evaluates client bundles as classic scripts.\n${report}`,
  )
}

// 4. Sanity-check that every external the bundle imports was detected as a require.
//    A miss here means an identifier would be undefined at runtime without any build error.
const externals = (readFileSync(resolve('tsdown.config.ts'), 'utf8').match(/external:\s*\[([^\]]*)\]/s)?.[1] ?? '')
  .split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
const missing = externals.filter(name => name !== 'react'
  && !code.includes(`require(${JSON.stringify(requireKey(name))})`)
  && !code.includes(`require(${JSON.stringify(name)})`))
if (missing.length > 0) {
  console.warn(`wrap-client: note — declared externals never required by ${inputFile}: ${missing.join(', ')}`)
}

// 5. Idempotence: wrapping twice nests the factory and produces a bundle that
//    silently double-initialises (verified: the file ends up with two
//    `__ModuleLoader__.load` calls and still reports success). A rebuild-less rerun — by
//    hand, from an IDE task, or from a future script — must be a no-op instead.
if (code.startsWith('window.__ModuleLoader__.load(')) {
  console.log(`✓ already wrapped ${inputFile} as ${packageId} (skipped)`)
  process.exit(0)
}

// 6. Wrap in ModuleLoader factory
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`
const intro = 'var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

const wrapped = `${banner}\n${intro}\n${code}\n${footer}\n`
// Atomic replace: a truncated 500 KB bundle that the installer would happily copy (it only checks
// non-emptiness and md5 source==dest) is worse than a failed build. Same reasoning as the plugin's
// own writeFileAtomic.
const tmp = `${filePath}.tmp`
writeFileSync(tmp, wrapped, 'utf8')
renameSync(tmp, filePath)
console.log(`✓ wrapped ${inputFile} as ${packageId}`)
