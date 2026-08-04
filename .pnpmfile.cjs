const excludedPiAiDependencies = [
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@google/genai",
  "@mistralai/mistralai",
  "@opentelemetry/api",
  "@smithy/node-http-handler",
  "http-proxy-agent",
  "https-proxy-agent",
]

module.exports = {
  hooks: {
    readPackage(packageManifest) {
      if (
        packageManifest.name !== "@earendil-works/pi-ai" ||
        packageManifest.version !== "0.82.1"
      ) {
        return packageManifest
      }
      for (const dependency of excludedPiAiDependencies) {
        delete packageManifest.dependencies?.[dependency]
      }
      return packageManifest
    },
  },
}
