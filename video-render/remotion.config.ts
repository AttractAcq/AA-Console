import { Config } from "@remotion/cli/config";

// NodeNext emits .js specifiers; make the Studio resolve their TS/TSX sources.
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: { ...config.resolve?.extensionAlias, ".js": [".tsx", ".ts", ".js"] },
  },
}));
