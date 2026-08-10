# Studio extension API v1

Studio has two deliberately different extension trust levels:

- Built-ins are statically bundled TypeScript `ExtensionDefinition` objects. They are
  trusted application code, but every contribution still passes through
  `ExtensionRegistry` permission, selection, validation, size, timeout, and failure
  boundaries.
- Third-party packages use the code-free `knead-extension-package` JSON schema.
  Package data is compiled into host-owned operations by
  `compileDeclarativeExtensionPackage`; source strings, modules, remote URLs,
  `eval`, `Function`, and dynamic scripts are never loaded.

The registry provides frozen structured-cloned snapshots, validates transform
results through the current project parser, restricts replacement to IDs explicitly
selected by the host, and contains lifecycle/execution errors as `ExtensionResult`
values. The JSON package layer additionally enforces strict known fields, schema and
API versions, exact capabilities, semantic versions, package/store budgets, bounded
pipelines, bounded duplication, and collision-free IDs.

See [the Extension Package SDK](../../../../docs/extensions-sdk.md) for the package
schema, operation catalog, installation lifecycle, security model, and a complete
example.

Internal trusted extensions can continue to use the typed API:

```ts
const registry = new ExtensionRegistry()
registry.register(humanizeExtension, [
  'timeline.read',
  'timeline.transform',
  'selection.read',
])
await registry.activate(humanizeExtension.manifest.id)

const result = await registry.executeMarkerTransform(
  humanizeExtension.manifest.id,
  humanizeTransform,
  DEFAULT_HUMANIZE_OPTIONS,
  { project: timeline.state, markerIds: selectedMarkerIds },
)
if (result.ok) timeline.replaceAll(result.value)
```

Use `defineCommand`, `defineMarkerTransform`, and `defineTrackTransform` to retain
option/input/output typing. Typed definitions are for audited bundled code only; the
Extension Manager intentionally imports JSON packages, never JavaScript definitions.
