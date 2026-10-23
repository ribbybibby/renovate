This datasource identifies an image's source repository according to the [pre-defined annotation keys of the OCI Image Format Specification](https://github.com/opencontainers/image-spec/blob/main/annotations.md).

This datasource looks for the metadata of the **latest stable** image found on the Docker registry and uses the value of the label `org.opencontainers.image.source` and `org.label-schema.vcs-url` as the `sourceUrl`.
Additionally, it uses the value of the label `org.opencontainers.image.revision` as the `gitRef`.

The [Label Schema](https://label-schema.org/) is superseded by OCI annotations, use the `org.opencontainers.image.source` label if possible.

If you maintain a Docker image and want Renovate to find your changelogs, add a `org.opencontainers.image.source` field to your Dockerfile.
The link must point to your GitHub or GitLab repository.
Here's an example from our `renovate/renovate` Dockerfile:

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/renovatebot/renovate"
```

If you use [Harbor](https://goharbor.io/) as a proxy cache for Docker Hub, then you must use Harbor version `2.5.0` or higher.

## Chainguard (`cgr.dev`)

The OCI distribution API gives no release timestamp for a tag, so `minimumReleaseAge` normally does nothing outside Docker Hub.
For images on `cgr.dev` Renovate reads tags from the Chainguard platform API instead, which does.

Chainguard rebuilds every supported tag whenever one of its packages changes, so the digest a tag such as `3.14` points at is nearly always only hours old.
Aging that timestamp against a window of days would hold every update forever, so when `minimumReleaseAge` is set Renovate asks the platform API what the tag pointed at when the window opened, and proposes _that_ digest.
The update Renovate raises for `3.14` is therefore a digest which has been published for at least `minimumReleaseAge`, rather than being withheld until the tag stops being rebuilt.

A rewound release is pinned to the digest the tag pointed at, which for a multi-architecture repository is the image index rather than an architecture-specific manifest.

Rewinding means pinning a digest that Chainguard has already superseded, which may include a rebuild that carried a CVE fix.
That is the trade `minimumReleaseAge` asks for, but it is worth stating plainly for a registry whose whole purpose is shipping patched images.

A rewound release is pinned to the digest the tag pointed at, which for a multi-architecture repository is the image index rather than an architecture-specific manifest.

To use this, give Renovate a token for the platform API:

```json
{
  "hostRules": [
    {
      "hostType": "docker",
      "matchHost": "cgr.dev",
      "username": "<your-pull-username>",
      "password": "<your-pull-token>"
    },
    {
      "hostType": "docker",
      "matchHost": "console-api.enforce.dev",
      "token": "<your-chainguard-token>"
    }
  ]
}
```

Renovate only queries the platform API when the second rule is present; without it `cgr.dev` is read over the distribution API as before, and `minimumReleaseAge` does not apply.
The API rejects anonymous requests, so there is nothing to be gained by trying.

Mint the token with [`chainctl`](https://edu.chainguard.dev/chainguard/chainguard-enforce/chainctl-docs/):

```bash
chainctl auth token --audience https://console-api.enforce.dev
```

The token needs to read both IAM groups and the registry, because a `cgr.dev` path is resolved group by group before its tags can be listed.
It is short-lived and must be refreshed before each run, so an [assumable identity](https://edu.chainguard.dev/chainguard/administration/assumable-ids/) is the only practical option for unattended use.
