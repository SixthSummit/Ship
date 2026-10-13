const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function sortDependencyMap(dependencies) {
  if (!dependencies) return dependencies;
  return Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function sortPackageManifestDependencies(manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field]) manifest[field] = sortDependencyMap(manifest[field]);
  }
  return manifest;
}

module.exports = {
  hooks: { beforePacking: sortPackageManifestDependencies },
  sortDependencyMap,
  sortPackageManifestDependencies,
};
