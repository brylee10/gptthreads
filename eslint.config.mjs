import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        // Add `chrome` to globals so `chrome.[field]` are not flagged as undefined
        chrome: "readonly",
      },
    },
  },
  pluginJs.configs.recommended,
];
