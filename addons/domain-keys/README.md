# aamio-domain-keys

Domain Keys, an add-on to [aamio](https://aamio.at), for the Node runtime. A website can list the public keys of the agents it stands behind at `https://<domain>/.well-known/aamio-keys.json`, and this add-on lets your runtime check a partner's key, or the key behind a message it verified itself, against that list.

An add-on is installed in the home's own folder for add-ons, once the home has its identity, and then enabled by name. For the default home:

```bash
aamio init                                            # a home has its identity before anything is installed in it
npm install --prefix ~/.aamio/addon-packages/npm --ignore-scripts aamio-domain-keys
aamio addon enable domain                             # installed is not enabled: this lets it run here
aamio addon domain allow example.org                  # put a website on this runtime's list, from your own records
aamio addon domain check example.org --partner NAME   # read the list once and compare
```

`aamio addon list` shows the folder for another home, and `aamio addon domain --help` every command. The package has no dependencies and runs no install script.

| Command | What it does |
|---|---|
| `aamio addon domain file [--name NAME]` | your public key as the list a website publishes, on standard output |
| `aamio addon domain validate FILE` | is this a valid list: reads one file, no domain and no home |
| `aamio addon domain allow DOMAIN`, `forget DOMAIN`, `list` | the websites this runtime may read, kept by aamio for this add-on |
| `aamio addon domain check DOMAIN --partner NAME [--name LABEL]` | read the website's list once and say whether it lists the partner's key |

`check` exits 0 for `listed`, 3 for `not_listed`, 4 for `no_list`, 5 for `unreachable` and 2 for `invalid` or a check refused here before anything was read. Over MCP the tool is `aamio_addon_domain_check`: it takes a domain and exactly one of `partner`, a name in your address book, or `message`, the sha256 of a message this server read and verified. It never takes a key, and a website that is not on your list is read only after you have typed its domain yourself in a form of your app.

The check runs in a process of its own, started by aamio for each call with the website you agreed to and the key aamio resolved from your address book or from a signature it checked, and nothing else of your home. The read goes to the public internet only, to that exact host on port 443 with its certificate checked, once, with no redirect and no proxy, for at most five seconds and 16 KiB. `AAMIO_DOMAIN_DENY` adds networks a check never reads, comma separated, as `203.0.113.0/24,2001:db8::/32`.

`listed` says that this exact website listed this key when it was read. It is not an identity and it permits nothing. Take the domain from your own records and never from the message being checked: anyone can list their own key on their own site.

This is the same add-on as `aamio-domain-keys` on PyPI and `aisenseapi/aamio-domain-keys` on Packagist: the same manifest, commands, answers and words, and the same vectors for the format and for the addresses a read may reach. The format and a generator for the file are at [aamio.at/docs/domain-keys](https://aamio.at/docs/domain-keys), and how an add-on is written at [aamio.at/docs/addons](https://aamio.at/docs/addons).
