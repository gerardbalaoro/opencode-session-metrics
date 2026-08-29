# TypeScript Rules

Write straightforward, domain-oriented TypeScript. Prefer clear intent, strong inference, and simple
control flow over cleverness.

## Types

- Rely on type inference whenever possible.
- Prefer schemas, function signatures, and API definitions as the source of truth.
- Fix typing at the source instead of casting at the point of use.
- Avoid explicit type annotations and interfaces unless needed for exports or clarity.
- Avoid `any`; use `unknown` when the type is genuinely unknown.
- Avoid duplicating types that can be inferred.

## Naming

- Prefer short, single-word names where the meaning remains clear.
- Use multiple words when needed to preserve domain meaning or avoid ambiguity.
- Prefer domain vocabulary over generic names such as `data`, `manager`, or `helper`.
- Short names are fine in tightly scoped callbacks where context is obvious.
- Use semantic boolean names such as `isLoading`, `hasChanges`, and `canPublish`.
- Use `<Concept>Schema` for schemas.
- Name functions by intent: `getX`, `createX`, `isX`, `hasX`, or verb + domain noun.

## Functions

- Prefer named function declarations for module-level functions.
- Use arrow functions mainly for callbacks and trivial factories.
- Keep logic in one function unless extraction makes it reusable, composable,
  or meaningfully clearer.
- Do not create helpers used once unless the helper gives an important concept a name.
- Prefer early returns over nesting.
- Keep workflows visibly sequential.

## Variables and Control Flow

- Default to `const`.
- Avoid `let`; use it only when reassignment is genuinely part of the algorithm
  and not for assigning a value through branches.
- Prefer expressions, early returns, or an IIFE when a value can be computed directly.
- Avoid `else` when an early return makes the flow clearer.
- Prefer explicit `if` and `switch` statements over dense expression chains.
- Use ternaries only for simple value selection.
- Avoid `try`/`catch` where errors can naturally propagate.

## Object Access

- Avoid unnecessary destructuring when it removes useful context.
- Prefer `user.name` and `user.email` over destructuring when the object name adds meaning.
- Destructure when it genuinely improves readability or matches the surrounding API.

## Abstraction

- Abstract for meaning, not deduplication.
- Prefer obvious domain-specific code over generic abstractions with flags, callbacks, or
  complicated generics.
- Do not introduce abstractions solely to reduce line count.
- Prefer expressive names and structure over comments.

## Imports

- Treat `../` imports as a sign that the dependency should have a stable public import path.
- If code is intended to be shared or consumed outside its local module boundary,
  expose it as a [subpath import](https://nodejs.org/api/packages.html#subpath-imports)
  rather than importing it via a parent-relative path.
