import { useEffect, useState } from "react";

const FALLBACK_TAG = `v${import.meta.env.VITE_APP_VERSION}`;
const FALLBACK_RELEASE = {
  tag_name: FALLBACK_TAG,
  html_url: `https://github.com/cnmbdb/tg-emoji-hub/releases/tag/${FALLBACK_TAG}`,
};

type GitHubRelease = {
  tag_name: string;
  html_url: string;
};

function compareReleaseTags(left: string, right: string): number {
  const parse = (tag: string) => tag.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftParts[index]) - Number(rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

export default function ReleaseVersion() {
  const [release, setRelease] = useState<GitHubRelease>(FALLBACK_RELEASE);

  useEffect(() => {
    let active = true;

    void fetch(`/api/version?fallback=${encodeURIComponent(FALLBACK_TAG)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as Partial<GitHubRelease>;
        if (
          typeof data.tag_name !== "string" ||
          typeof data.html_url !== "string"
        ) {
          return undefined;
        }
        return { tag_name: data.tag_name, html_url: data.html_url };
      })
      .catch(() => undefined)
      .then((latest) => {
        if (
          active &&
          latest &&
          compareReleaseTags(latest.tag_name, FALLBACK_TAG) >= 0
        ) {
          setRelease(latest);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <a
      href={release.html_url}
      target="_blank"
      rel="noopener noreferrer"
      title={
        `GitHub Release ${release.tag_name}`
      }
      aria-label={`View release ${release.tag_name}`}
      className="hidden font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground sm:inline"
    >
      {release.tag_name}
    </a>
  );
}
