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
No extra configuration is needed: the extension uses the same credentials as pulling the image, and registries which do not serve it answer `404`.

Chainguard rebuilds every supported tag whenever one of its packages changes, so the digest a tag such as `3.14` points at is nearly always only hours old, and a cooldown measured in days would never pass.
Where Renovate writes the digest to the package file — with [`pinDigests`](../../../configuration-options.md#pindigests), or a reference which is already digest-pinned — and `RENOVATE_X_REWIND_DIGESTS` is set, it instead proposes the digest the tag pointed at when the window opened, which has been published long enough to satisfy the policy.
That means pinning a digest Chainguard has already superseded, possibly one that was replaced by a CVE fix.

A bare `cgr.dev/my-org/python:3.14` resolves to whatever the tag points at when it is pulled, so there is no digest to hold it still.
Those references are dated by the digest the tag points at now, and an update to a tag that is still being rebuilt stays pending until the tag has been unchanged for `minimumReleaseAge`.
Pin digests if you want cooldowns to be satisfiable on `cgr.dev`.

This is a behaviour change if you set `minimumReleaseAgeBehaviour=timestamp-optional` to work around `cgr.dev` having no timestamps: updates which previously flowed because nothing could be dated are now dated, and an unpinned tag that is still being rebuilt stays pending.

A rewound digest is the one the tag pointed at, which for a multi-architecture repository is the image index rather than an architecture-specific manifest — so an existing architecture-specific pin becomes an index pin.

The timestamp is when the tag was last rebuilt, not when its version was first published, which is the same conflation [#38659](https://github.com/renovatebot/renovate/issues/38659) tracks for Docker Hub but far more visible here.
It reaches `currentVersionAgeInDays` and [`matchCurrentAge`](../../../configuration-options.md#packagerulesmatchcurrentage) too: a `cgr.dev` dependency previously had no timestamp, so `matchCurrentAge` never matched it, and now reports the age of the last rebuild however long the version itself has been in use.
