/** @type {import("next").NextConfig} */
// On GitHub Pages this site is served from https://codedvibesx.github.io/preopen, not from a domain root. GITHUB_PAGES is
// set only by the Pages workflow, so `next dev` and a plain local build still run at the root.
const onPages = process.env.GITHUB_PAGES === "true";
const base = "/preopen";

const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  devIndicators: false,
  basePath: onPages ? base : "",
  assetPrefix: onPages ? base : "",
};

export default nextConfig;
