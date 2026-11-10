import { Field, h, Notice, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

// Kept in step with resources.ts by configurator.test.ts. A module is bundled in isolation.
function selectedUrl(values: { url?: string | null }, patterns?: readonly string[]): string {
  return values.url ?? patterns?.[0] ?? "";
}

function validUrl(value: string): boolean {
  const match = /^bsport:\/\/production\/companies\/([1-9]\d*)(?:\/(bookings|classes|customers|subscriptions|subscriptionProducts|classPassProducts|appointmentPassProducts|customerClassPasses|customerAppointmentPasses|invoices)(?:\/([^/]+))?)?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  if (!match[3]) return true;
  return match[2] === "invoices" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(match[3]) : /^[1-9]\d*$/.test(match[3]) && Number.isSafeInteger(Number(match[3]));
}

export default {
  initial: { url: null as string | null },
  initialValuesFromResourceUrl({ resourceUrl }) { return { url: resourceUrl }; },
  isReady({ values, acceptedResourceUrlPatterns }) {
    const url = selectedUrl(values, acceptedResourceUrlPatterns);
    if (!validUrl(url)) return false;
    return !acceptedResourceUrlPatterns || acceptedResourceUrlPatterns.some(pattern => new URLPattern(pattern).test(url));
  },
  resourceUrl({ values, acceptedResourceUrlPatterns }) { return selectedUrl(values, acceptedResourceUrlPatterns); },
  render({ values, setValues, acceptedResourceUrlPatterns }) {
    return <Section>
      <Notice>Read-only. Choose the company, one collection, or one record. Results stay private to this connection.</Notice>
      <Field label="bsport resource URL" description="Keep the configured company. For a single record, replace :recordId with its bsport ID (a UUID for invoices).">
        <TextInput name="url" value={selectedUrl(values, acceptedResourceUrlPatterns)} placeholder="bsport://production/companies/…" onChange={url => setValues({ url: url ?? "" })} />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<null, { url?: string | null }>;
