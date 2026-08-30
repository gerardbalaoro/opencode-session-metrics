import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
  },
  categories: {
    correctness: "error",
  },
  plugins: ["typescript", "unicorn", "oxc"],
  rules: {
    "no-await-in-loop": "off",
    "eslint/no-unused-vars": "error",
    "typescript/no-deprecated": "error",
  },
});
