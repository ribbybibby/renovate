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

The OCI distribution API reports no release timestamp for a tag, so `minimumReleaseAge` normally does nothing outside Docker Hub.
Chainguard serves a tag's history as an [OCI extension](https://github.com/opencontainers/distribution-spec/blob/main/extensions/_oci.md) at `/v2/{name}/_chainguard/history/{tag}`, which Renovate uses to date a `cgr.dev` release.

Chainguard rebuilds every supported tag whenever one of its packages changes, so the digest a tag such as `3.14` points at is nearly always only hours old.
Ageing that timestamp against a window of days would hold every update forever, so when `minimumReleaseAge` is set Renovate takes the digest the tag pointed at when the window opened and proposes _that_.
The update Renovate raises for `3.14` is therefore a digest which has been published for at least `minimumReleaseAge`, rather than being withheld until the tag stops being rebuilt.

Rewinding means pinning a digest that Chainguard has already superseded, which may include a rebuild that carried a CVE fix.
That is the trade `minimumReleaseAge` asks for, but it is worth stating plainly for a registry whose purpose is shipping patched images.

A rewound release is pinned to the digest the tag pointed at, which for a multi-architecture repository is the image index rather than an architecture-specific manifest.
A tag which has never pointed at anything old enough is reported as pending, like any other release which has not aged yet.

No extra configuration is needed: the extension is served by `cgr.dev` itself and uses the same credentials as pulling the image.
Registries which do not serve the extension answer `404`, and Renovate carries on as before.
