import { defineConfig } from "tsdown/config";
import solid from "unplugin-solid/rolldown";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
  fixedExtension: false,
  unbundle: true,
  dts: true,
  deps: {
    neverBundle: true,
  },
  plugins: [
    solid({
      solid: {
        generate: "universal",
        moduleName: "@opentui/solid",
      },
    }),
  ],
});
