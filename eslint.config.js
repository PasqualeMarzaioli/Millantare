// eslint.config.js — Check application, import, setup, and test code.
// Explicit platform globals keep undefined variables visible without extra packages.
// Author: Pasquale Marzaioli
export default [{
  ignores: ["node_modules/**", "dist/**", ".wrangler/**"],
}, {
  files: ["**/*.js"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    globals: Object.fromEntries([
      "fetch", "Request", "Response", "URL", "AbortSignal", "console", "setTimeout", "process", "structuredClone",
    ].map((name) => [name, "readonly"])),
  },
  rules: {
    "no-undef": "error",
    "no-unused-vars": "error",
    "no-unreachable": "error",
    "no-constant-condition": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "eqeqeq": "error",
    "curly": "error",
  },
}];
