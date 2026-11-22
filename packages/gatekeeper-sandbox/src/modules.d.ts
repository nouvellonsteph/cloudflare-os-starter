declare module "*.txt" {
  const text: string;
  export default text;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "SandboxWorkspace" | "SandboxGatekeeper";
  }
}
