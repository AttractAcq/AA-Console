import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

// NodeNext emits .js specifiers; make the Studio resolve their TS/TSX sources.
Config.overrideBundlerConfig((config) => enableTailwind({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: { ...config.resolve?.extensionAlias, ".js": [".tsx", ".ts", ".js"] },
  },
}));
