/**
 * What a recording may contain, and what it may never contain.
 *
 * Out of the box the recorder keeps what a visitor types: that is what makes a
 * replay of a form nobody could finish worth watching. Two options turn that
 * off — `maskAllInputs` for form controls, `maskAllTyping` for form controls
 * plus every `contenteditable` region — and underneath both of them sits a
 * floor this file defines: fields whose value never leaves the browser in any
 * configuration, because no support ticket is worth a password or a card
 * number sitting in a session replay.
 *
 * Why the floor is applied to the *events* rather than through rrweb's own
 * hooks: rrweb takes a `maskInputFn`, but the version we bundle calls it with
 * the value alone — `maskInputFn(text)` — on every path, snapshot included. A
 * function that cannot see the field cannot tell a card number from a search
 * box, so rrweb's masking can only ever be all-or-nothing by input type. What
 * rrweb does put in every payload is the node's id, and the full snapshot
 * carries each field's attributes. That is enough: `scrubEvent` re-reads every
 * event before the transport sees it and masks what the policy says must be
 * masked. Nothing unmasked is ever queued, let alone sent.
 */

/** Same length, no characters — what rrweb itself writes for a masked value. */
export const maskValue = (text: string): string => '*'.repeat(text.length);

/**
 * Every form field, masked — spelled out rather than using rrweb's
 * `maskAllInputs: true` shorthand.
 *
 * The shorthand builds a map keyed by input *type*, and the snapshot reads that
 * type from the `type` attribute rather than the element. An `<input>` written
 * without one — `<input name="city" value="…">`, the shape React apps produce —
 * therefore matched no key, and its **initial** value was serialised in the
 * clear even with masking on. What the visitor then typed into it was masked,
 * because the input observer reads `element.type`, which defaults to `text`;
 * only the value already in the markup leaked. The `input` key closes that: it
 * is matched on the tag name, which every input has. Radio buttons and
 * check boxes are untouched — both paths settle them by `checked` before any
 * value masking is considered.
 */
export const MASK_EVERY_FIELD: Record<string, boolean> = {
  color: true, date: true, 'datetime-local': true, email: true, month: true,
  number: true, range: true, search: true, tel: true, text: true, time: true,
  url: true, week: true, textarea: true, select: true, password: true,
  input: true,
};

/* ------------------------------------------------------------ the floor -- */

/**
 * Autocomplete tokens that name a credential or a payment instrument.
 *
 * `autocomplete` is the one signal a browser itself acts on — it is what makes
 * a browser offer to fill in a card number — so a field carrying one of these
 * is that field, whatever else it is called.
 */
const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-type',
  'cc-given-name', 'cc-family-name', 'cc-additional-name',
  'current-password', 'new-password', 'one-time-code',
]);

/**
 * How a payment field is named when nobody set `autocomplete`.
 *
 * Deliberately narrow: every match here is a field a customer can never see
 * again, so a false positive costs them a replay they wanted. Each alternative
 * needs a payment word — `card`, `cc`, `cvv` and friends, `iban`, a bank
 * routing number — and the boundaries keep `discard`, `scoreboard` and
 * `accounting` out of it.
 */
const PAYMENT_FIELD = new RegExp(
  '(?:credit|debit|payment)[\\s_-]*card'
  + '|card[\\s_-]*(?:number|num|no|nr|code|pin|cvv|cvc|csc)'
  + '|(?:^|[^a-z])cc[\\s_-]*(?:number|num|no|nr|csc|cvv|cvc|exp)'
  + '|(?:^|[^a-z])(?:cvv|cvc|cvn|csc)(?:[^a-z]|$)'
  + '|security[\\s_-]*code'
  + '|(?:^|[^a-z])iban(?:[^a-z]|$)'
  + '|routing[\\s_-]*number'
  + '|sort[\\s_-]*code',
  'i',
);

/** How a credential field is named. Covers the "show password" toggle, which flips `type` to text. */
const CREDENTIAL_FIELD = /pass(?:word|wd|phrase)|(?:^|[^a-z])pwd(?:[^a-z]|$)|(?:^|[^a-z])otp(?:[^a-z]|$)|one[\s_-]*time[\s_-]*code/i;

/**
 * Input types that are never recorded, whatever the options say.
 *
 * Only `password`. `type="email"` and `type="tel"` were here once, and are not
 * any more: an address and a phone number are ordinary contact details that a
 * sign-up form is mostly made of, and a replay of a sign-up nobody could finish
 * is worth nothing with both of them starred out. They are recorded by default
 * and masked the way every other ordinary field is — `maskAllInputs`,
 * `maskAllTyping`, or the mask class on the field or anything around it.
 *
 * What stays is what a customer can never un-see: a credential, a one-time
 * code, a payment instrument. See the two patterns above and the Luhn check
 * below for the rest of it.
 */
const SENSITIVE_TYPES = new Set(['password']);

/**
 * What rrweb itself masks when values are being recorded.
 *
 * Built from `SENSITIVE_TYPES` rather than written out a second time: rrweb's
 * masking is by input type, which is exactly the part of the floor a type can
 * express, and two hand-kept lists would eventually disagree about which one
 * the documentation describes. Everything else in the floor is applied by
 * `scrubEvent`, which can see the whole field.
 */
export const MASK_SENSITIVE_FIELDS: Record<string, boolean> = Object.fromEntries(
  [...SENSITIVE_TYPES].map((type) => [type, true]),
);

/** The attributes a field's purpose is written in, in practice. */
const NAMING_ATTRIBUTES = ['name', 'id', 'autocomplete', 'placeholder', 'aria-label', 'data-testid'];

/** Reads one attribute of a field, whether it is a live element or a serialised node. */
type Attributes = (name: string) => string | null;

/** The floor, decided from the attributes alone, so both callers get the same answer. */
function isSensitiveByAttributes(read: Attributes, type: string): boolean {
  // rrweb's own marker, set by pages that toggle a password field to text.
  if (read('data-rr-is-password') !== null) return true;
  if (SENSITIVE_TYPES.has(type)) return true;

  const autocomplete = (read('autocomplete') ?? '').toLowerCase();
  // "section-blue shipping cc-number" — the meaning is in the last token, but
  // checking every token costs nothing and tolerates a hand-written value.
  for (const token of autocomplete.split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
  }

  for (const attribute of NAMING_ATTRIBUTES) {
    const value = read(attribute);
    if (value && (PAYMENT_FIELD.test(value) || CREDENTIAL_FIELD.test(value))) return true;
  }
  return false;
}

type MaybeElement = { getAttribute?: unknown } | null | undefined;

const asElement = (node: MaybeElement): Element | null =>
  node && typeof (node as Element).getAttribute === 'function' ? (node as Element) : null;

/**
 * Is this live field one whose value never leaves the browser?
 *
 * Reads `element.type` rather than the attribute, so `<input>` with no type —
 * which is a text field — is judged as one.
 */
export function isSensitiveField(node: MaybeElement): boolean {
  const element = asElement(node);
  if (!element) return false;
  const type = ((element as HTMLInputElement).type || element.getAttribute('type') || '').toLowerCase();
  return isSensitiveByAttributes((name) => element.getAttribute(name), type);
}

/** The same question for a field as rrweb serialised it, where only the attributes exist. */
function isSensitiveSerialised(attributes: Record<string, unknown>): boolean {
  const read: Attributes = (name) => (typeof attributes[name] === 'string' ? attributes[name] as string : null);
  return isSensitiveByAttributes(read, (read('type') ?? '').toLowerCase());
}

/**
 * Does this value look like a card number?
 *
 * The last line of defence, for the checkout that calls its field `field-2`
 * and sets no autocomplete. A card number is 13–19 digits and passes the Luhn
 * check, which one number in ten passes by chance — so an order number can be
 * caught by this, and that is the trade it makes: a masked order number is a
 * smaller loss than a recorded card number.
 */
export function looksLikeCardNumber(text: string): boolean {
  if (text.length < 13 || text.length > 24 || !/^[0-9][0-9 -]*[0-9]$/.test(text)) return false;
  const digits = text.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Has the customer marked this field, or something around it, with the mask
 * class?
 *
 * rrweb's `maskTextClass` reaches text nodes only — an `<input>` has none, so
 * `class="ar-mask"` on a field did nothing to its value. This closes that: the
 * class means the same thing on a field as it does on a paragraph.
 */
function isMarkedByCustomer(node: MaybeElement, maskClass: string): boolean {
  let element = asElement(node);
  while (element) {
    if (element.classList?.contains(maskClass)) return true;
    element = element.parentElement;
  }
  return false;
}

const hasClass = (attributes: Record<string, unknown>, maskClass: string): boolean =>
  typeof attributes.class === 'string' && attributes.class.split(/\s+/).includes(maskClass);

export interface MaskingPolicy {
  /** True when every field value is masked: `maskAllInputs` or `maskAllTyping`. */
  maskEveryField: boolean;
  /** The customer's mask class, honoured on fields as well as on the text around them. */
  maskClass: string;
}

/** The floor, plus whatever the customer asked for on top of it, for a live field. */
export function shouldMaskValue(text: string, node: MaybeElement, policy: MaskingPolicy): boolean {
  if (policy.maskEveryField) return true;
  if (isSensitiveField(node)) return true;
  if (isMarkedByCustomer(node, policy.maskClass)) return true;
  return looksLikeCardNumber(text);
}

/* --------------------------------------------------------- the payloads -- */

interface SerialisedNode {
  type?: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerialisedNode[];
}

interface IncrementalData {
  source?: number;
  id?: unknown;
  text?: unknown;
  attributes?: { id?: unknown; attributes?: Record<string, unknown> }[];
  adds?: { parentId?: unknown; node?: SerialisedNode }[];
}

/** rrweb's IncrementalSource values for the payloads that can carry a field value. */
const MUTATION = 0;
const INPUT = 5;
/** rrweb's NodeType values. */
const ELEMENT_NODE = 2;
const TEXT_NODE = 3;
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/** Replaces every text node under a node with asterisks. A textarea's initial content is one. */
function maskTextChildren(node: SerialisedNode): void {
  for (const child of node.childNodes ?? []) {
    if (child.type === TEXT_NODE && typeof child.textContent === 'string') {
      child.textContent = child.textContent.replace(/\S/g, '*');
    }
    maskTextChildren(child);
  }
}

/**
 * Walks a serialised tree and masks the value of every field the policy covers.
 *
 * Used for the full snapshot and for nodes added later, which is where a value
 * that was in the markup — or one a framework rendered a second after load —
 * rides out of the browser. `masked` is inherited: a field inside an element
 * the customer marked is masked even though the mark is on the ancestor.
 */
function scrubTree(node: SerialisedNode | undefined, policy: MaskingPolicy, masked: boolean): void {
  if (!node) return;
  const attributes = node.attributes ?? {};
  const inheritedMask = masked || hasClass(attributes, policy.maskClass);

  if (node.type === ELEMENT_NODE && node.tagName && FIELD_TAGS.has(node.tagName.toLowerCase())) {
    const value = attributes.value;
    const shouldMask = policy.maskEveryField
      || inheritedMask
      || isSensitiveSerialised(attributes)
      || (typeof value === 'string' && looksLikeCardNumber(value));
    if (shouldMask) {
      if (typeof value === 'string' && value !== '') attributes.value = maskValue(value);
      // A textarea's initial content is a text node as well as a value, and
      // rrweb serialises both.
      if (node.tagName.toLowerCase() === 'textarea') maskTextChildren(node);
    }
  }

  for (const child of node.childNodes ?? []) scrubTree(child, policy, inheritedMask);
}

/**
 * Re-applies the floor to an event rrweb has already built.
 *
 * Events are scrubbed in place, before the transport sees them.
 */
export function scrubEvent(
  event: { type?: number; data?: unknown },
  getNode: (id: number) => MaybeElement,
  policy: MaskingPolicy,
): void {
  if (!event.data) return;

  // The first full picture of the page: every value that was in the markup.
  if (event.type === 2) {
    scrubTree((event.data as { node?: SerialisedNode }).node, policy, false);
    return;
  }
  if (event.type !== 3) return;
  const data = event.data as IncrementalData;

  if (data.source === INPUT) {
    if (typeof data.text !== 'string' || data.text === '') return;
    const node = typeof data.id === 'number' ? getNode(data.id) : null;
    // A check box or radio button reports `checked`; its `value` is markup the
    // page wrote, not anything a person typed, and the replayer needs it to
    // tell one radio button in a group from another.
    const type = ((asElement(node) as HTMLInputElement | null)?.type ?? '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return;
    if (shouldMaskValue(data.text, node, policy)) data.text = maskValue(data.text);
    return;
  }

  if (data.source !== MUTATION) return;

  // A value a script assigned, which arrives as an attribute change.
  for (const entry of data.attributes ?? []) {
    const value = entry?.attributes?.value;
    if (typeof value !== 'string' || value === '') continue;
    const node = typeof entry.id === 'number' ? getNode(entry.id) : null;
    if (shouldMaskValue(value, node, policy)) entry.attributes!.value = maskValue(value);
  }
  // A field the page added after the snapshot, serialised the same way. The
  // mark that covers it may be on an element that was already there, so the
  // parent it is being attached to decides where the walk starts.
  for (const add of data.adds ?? []) {
    const parent = typeof add?.parentId === 'number' ? getNode(add.parentId) : null;
    scrubTree(add?.node, policy, isMarkedByCustomer(parent, policy.maskClass));
  }
}
