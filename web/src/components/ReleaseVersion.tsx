import { useEffect, useState } from "react";

const RELEASES_URL = "https://github.com/cnmbdb/tg-emoji-hub/releases";
const LATEST_RELEASE_API =
  "https://api.github.com/repos/cnmbdb/tg-emoji-hub/releases/latest";

type GitHubRelease = {
  tag_name: string;
  html_url: string;
};

export default function ReleaseVersion() {
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void fetch(LATEST_RELEASE_API)
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as Partial<GitHubRelease>;
        if (
          typeof data.tag_name !== "string" ||
          typeof data.html_url !== "string"
        ) {
          return null;
        }
        return { tag_name: data.tag_name, html_url: data.html_url };
      })
      .catch(() => null)
      .then((latest) => {
        if (!active) return;
        setRelease(latest);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const version = loading ? "…" : (release?.tag_name ?? "dev");

  return (
    <a
      href={release?.html_url ?? RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={
        release
          ? `GitHub Release ${release.tag_name}`
          : "View GitHub Releases"
      }
      aria-label={
        release
          ? `View release ${release.tag_name}`
          : "View GitHub Releases"
      }
      className="hidden font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground sm:inline"
    >
      {version}
    </a>
  );
}
