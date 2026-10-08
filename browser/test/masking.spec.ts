import { isSensitiveField, looksLikeCardNumber, mayBecomeCardNumber, scrubEvent, shouldMaskValue } from '../src/masking';

const field = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
};

const policy = { maskEveryField: false, maskClass: 'ar-mask' };

describe('the floor: fields no option can un-mask', () => {
  it('knows a credential when it sees one', () => {
    for (const html of [
      '<input type="password">',
      '<input data-rr-is-password type="text">',
      '<input type="text" autocomplete="current-password">',
      '<input type="text" autocomplete="new-password">',
      '<input type="text" name="user_password">',
      '<input type="text" id="pwd">',
      '<input type="text" name="otp">',
      '<input type="text" autocomplete="one-time-code">',
    ]) {
      expect(isSensitiveField(field(html)), html).toBe(true);
    }
  });

  it('knows a payment field by what the browser would fill it with', () => {
    for (const html of [
      '<input autocomplete="cc-number">',
      '<input autocomplete="cc-csc">',
      '<input autocomplete="cc-exp">',
      '<input autocomplete="cc-name">',
      // The browser's own form: several tokens, the meaning in the last one.
      '<input autocomplete="section-checkout billing cc-number">',
      '<select autocomplete="cc-exp-month"></select>',
    ]) {
      expect(isSensitiveField(field(html)), html).toBe(true);
    }
  });

  it('knows a payment field by its name when nobody set autocomplete', () => {
    for (const html of [
      '<input inputmode="numeric" name="cardNumber">',
      '<input inputmode="numeric" name="card-number">',
      '<input inputmode="numeric" id="cvv">',
      '<input inputmode="numeric" name="cvc">',
      '<input inputmode="numeric" placeholder="Security code">',
      '<input name="credit_card">',
      '<input aria-label="IBAN">',
      '<input data-testid="cc-csc-input">',
    ]) {
      expect(isSensitiveField(field(html)), html).toBe(true);
    }
  });

  it('leaves ordinary fields alone', () => {
    for (const html of [
      '<input name="city">',
      '<input name="full_name">',
      '<input type="search" name="q">',
      '<textarea name="message"></textarea>',
      // Contact details, not credentials: on the floor once, deliberately not
      // any more. A replay of a sign-up form is worth nothing with the address
      // and the phone number starred out.
      '<input type="email" name="email">',
      '<input type="tel" name="phone">',
      // Words that merely contain a payment word.
      '<input name="discard_draft">',
      '<input name="scoreboard">',
      '<input name="accounting_period">',
      '<input name="postcode">',
    ]) {
      expect(isSensitiveField(field(html)), html).toBe(false);
    }
  });

  it('says nothing about a node that is not an element', () => {
    expect(isSensitiveField(null)).toBe(false);
    expect(isSensitiveField(undefined)).toBe(false);
    expect(isSensitiveField(document.createTextNode('hi') as unknown as Element)).toBe(false);
  });
});

describe('a value that looks like a card number', () => {
  it('recognises the card numbers a checkout is tested with', () => {
    for (const number of [
      '4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242',
      '5555555555554444', '378282246310005', '6011111111111117',
    ]) {
      expect(looksLikeCardNumber(number), number).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const value of [
      '', '3', '4242', 'hunter2', '4242424242424241', '05321234567',
      '1234567890123456789012345', 'Ada Lovelace', '2026-09-18',
    ]) {
      expect(looksLikeCardNumber(value), value).toBe(false);
    }
  });
});

describe('a card number being typed', () => {
  it('is masked from the seventh digit, every keystroke after', () => {
    const typed = '4242424242424242';
    for (let n = 1; n <= typed.length; n += 1) {
      const prefix = typed.slice(0, n);
      expect(shouldMaskValue(prefix, field('<input name="field-2">'), policy), prefix).toBe(n > 6);
    }
    for (const prefix of ['4242 4242', '5555-5555-5', '378282246', '6011 1111 11']) {
      expect(mayBecomeCardNumber(prefix), prefix).toBe(true);
    }
  });

  it('leaves telephone numbers, quantities, postcodes and words alone', () => {
    for (const value of [
      '05321234567', '+90 532 123 45 67', '0044 20 7946 0958', '3', '34710', '424242',
      '12345678', '9876543210', 'Ada Lovelace', '2026-09-18', '42424242424242424242',
      '415-555-0100', '532 123 45 67',
    ]) {
      expect(mayBecomeCardNumber(value), value).toBe(false);
    }
  });
});

describe('the policy', () => {
  it('masks the floor and passes everything else through', () => {
    expect(shouldMaskValue('hunter2', field('<input type="password">'), policy)).toBe(true);
    expect(shouldMaskValue('Kadikoy', field('<input name="city">'), policy)).toBe(false);
    expect(shouldMaskValue('4242424242424242', field('<input name="field-2">'), policy)).toBe(true);
  });

  it('honours the mask class on a field, and on anything around it', () => {
    expect(shouldMaskValue('secret', field('<input class="ar-mask">'), policy)).toBe(true);
    document.body.innerHTML = '<div class="ar-mask"><p><input id="deep"></p></div>';
    expect(shouldMaskValue('secret', document.getElementById('deep'), policy)).toBe(true);
  });

  it('masks everything when the customer asked for that', () => {
    expect(shouldMaskValue('Kadikoy', field('<input name="city">'), { maskEveryField: true, maskClass: 'ar-mask' }))
      .toBe(true);
  });

  /**
   * Email and telephone fields are ordinary fields.
   *
   * Recorded by default, like a city or a name, and masked the moment the
   * customer turns masking on or marks the field. Asserted in one place so the
   * two halves of that promise cannot drift apart.
   */
  it('records an email or telephone field by default and masks it on request', () => {
    const everything = { maskEveryField: true, maskClass: 'ar-mask' };
    for (const html of ['<input type="email">', '<input type="tel">']) {
      expect(shouldMaskValue('ada@example.com', field(html), policy), html).toBe(false);
      expect(shouldMaskValue('ada@example.com', field(html), everything), html).toBe(true);
    }
    // And the mask class reaches them the way it reaches any other field.
    expect(shouldMaskValue('ada@example.com', field('<input type="email" class="ar-mask">'), policy)).toBe(true);
  });

  it('falls back to the value alone when there is no element to look at', () => {
    expect(shouldMaskValue('4242424242424242', null, policy)).toBe(true);
    expect(shouldMaskValue('Kadikoy', null, policy)).toBe(false);
  });
});

describe('scrubEvent', () => {
  const lookup = (node: HTMLElement | null) => () => node;

  it('masks a typing event for a field the floor covers', () => {
    const event = { type: 3, data: { source: 5, id: 7, text: '4242 4242 4242 4242', isChecked: false } };
    scrubEvent(event, lookup(field('<input autocomplete="cc-number">')), policy);
    expect(event.data.text).toBe('*'.repeat(19));
  });

  it(`leaves an ordinary field's typing alone`, () => {
    const event = { type: 3, data: { source: 5, id: 7, text: 'Ada Lovelace', isChecked: false } };
    scrubEvent(event, lookup(field('<input name="full_name">')), policy);
    expect(event.data.text).toBe('Ada Lovelace');
  });

  it(`leaves a check box's value alone, so the replay can tell the group apart`, () => {
    const event = { type: 3, data: { source: 5, id: 7, text: 'newsletter', isChecked: true } };
    scrubEvent(event, lookup(field('<input type="checkbox" name="cvc-consent" value="newsletter">')), policy);
    expect(event.data.text).toBe('newsletter');
  });

  it('masks a value a script writes into the markup', () => {
    const event = {
      type: 3,
      data: { source: 0, attributes: [{ id: 3, attributes: { value: 'hunter2', class: 'x' } }] },
    };
    scrubEvent(event, lookup(field('<input type="password">')), policy);
    expect(event.data.attributes[0]!.attributes.value).toBe('*******');
  });

  it('masks everything typed when the customer asked for that, element or no element', () => {
    const event = { type: 3, data: { source: 5, id: 7, text: 'Kadikoy', isChecked: false } };
    scrubEvent(event, () => null, { maskEveryField: true, maskClass: 'ar-mask' });
    expect(event.data.text).toBe('*******');
  });

  /** A field as rrweb serialises it into the full snapshot. */
  const node = (tagName: string, attributes: Record<string, unknown>, childNodes: unknown[] = []) =>
    ({ type: 2, tagName, attributes, childNodes, id: 9 });

  it('masks the values that were in the markup when recording started', () => {
    const snapshot = {
      type: 2,
      data: {
        node: node('body', {}, [
          node('input', { id: 'city', value: 'Istanbul' }),
          node('input', { type: 'password', value: 'hunter2' }),
          node('input', { autocomplete: 'cc-number', value: '4242424242424242' }),
          node('input', { name: 'order', value: '5555555555554444' }),
        ]),
      },
    };
    scrubEvent(snapshot, () => null, policy);
    const [city, password, card, order] = (snapshot.data.node.childNodes as { attributes: { value: string } }[]);
    expect(city!.attributes.value).toBe('Istanbul');
    expect(password!.attributes.value).toBe('*******');
    expect(card!.attributes.value).toBe('*'.repeat(16));
    // Named like nothing in particular, but the value is a card number.
    expect(order!.attributes.value).toBe('*'.repeat(16));
  });

  it('masks a marked field, and every field inside a marked element', () => {
    const snapshot = {
      type: 2,
      data: {
        node: node('body', {}, [
          node('div', { class: 'ar-mask' }, [node('input', { name: 'note', value: 'private' })]),
        ]),
      },
    };
    scrubEvent(snapshot, () => null, policy);
    const wrapper = (snapshot.data.node.childNodes as { childNodes: { attributes: { value: string } }[] }[])[0]!;
    expect(wrapper.childNodes[0]!.attributes.value).toBe('*******');
  });

  it("masks a textarea's initial text as well as its value", () => {
    const textarea = node('textarea', { name: 'message', value: 'dear sir' }, [
      { type: 3, textContent: 'dear sir', id: 10 },
    ]);
    const snapshot = { type: 2, data: { node: node('body', {}, [textarea]) } };
    scrubEvent(snapshot, () => null, { maskEveryField: true, maskClass: 'ar-mask' });
    expect((textarea.attributes as { value: string }).value).toBe('********');
    expect((textarea.childNodes as { textContent: string }[])[0]!.textContent).toBe('**** ***');
  });

  it('masks a field the page adds after the snapshot', () => {
    const event = {
      type: 3,
      data: {
        source: 0,
        adds: [{ parentId: 2, node: node('input', { type: 'password', value: 'hunter2' }) }],
      },
    };
    scrubEvent(event, () => null, policy);
    expect((event.data.adds[0]!.node.attributes as { value: string }).value).toBe('*******');
  });

  it('masks part of a card number that was in the markup, or in a field added later', () => {
    const snapshot = {
      type: 2,
      data: {
        node: node('body', {}, [
          node('input', { name: 'field-2', value: '4242 4242 42' }),
          node('input', { name: 'phone', value: '0532 123 45 67' }),
        ]),
      },
    };
    scrubEvent(snapshot, () => null, policy);
    const [card, phone] = (snapshot.data.node.childNodes as { attributes: { value: string } }[]);
    expect(card!.attributes.value).toBe('*'.repeat(12));
    expect(phone!.attributes.value).toBe('0532 123 45 67');

    const added = { type: 3, data: { source: 0, adds: [{ parentId: 2, node: node('input', { value: '42424242' }) }] } };
    scrubEvent(added, () => null, policy);
    expect((added.data.adds[0]!.node.attributes as { value: string }).value).toBe('********');
  });

  it('masks a card number typed into a contenteditable region, keystroke by keystroke', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>x</p></div><p>Order 4242424242</p>';
    const typedNode = document.querySelector('[contenteditable] p')!.firstChild!;
    const pageText = document.querySelector('body > p')!.firstChild!;
    const getNode = (id: number) => (id === 7 ? typedNode : id === 8 ? pageText : null) as never;

    const card = '4242 4242 4242 4242';
    for (let n = 1; n <= card.length; n += 1) {
      const typed = card.slice(0, n);
      const event = { type: 3, data: { source: 0, texts: [{ id: 7, value: typed }] } };
      scrubEvent(event, getNode, policy);
      const digits = typed.replace(/ /g, '').length;
      expect(event.data.texts[0]!.value, typed).toBe(digits > 6 ? typed.replace(/\S/g, '*') : typed);
    }

    // Ordinary words in an editor, and numbers in text nobody typed, stay.
    const words = { type: 3, data: { source: 0, texts: [{ id: 7, value: 'Call me on 0532 123 45 67' }, { id: 8, value: '4242424242' }] } };
    scrubEvent(words, getNode, policy);
    expect(words.data.texts.map((t) => t.value)).toEqual(['Call me on 0532 123 45 67', '4242424242']);

    // An editor that re-creates its text node on each keystroke, and one in the snapshot.
    const added = { type: 3, data: { source: 0, adds: [{ parentId: 6, node: { type: 3, id: 9, textContent: '42424242' } }] } };
    scrubEvent(added, () => document.querySelector('[contenteditable] p') as never, policy);
    expect(added.data.adds[0]!.node.textContent).toBe('********');
    const snapshot = {
      type: 2,
      data: { node: node('body', {}, [node('div', { contenteditable: 'true' }, [{ type: 3, id: 10, textContent: '5555 5555 55' }])]) },
    };
    scrubEvent(snapshot, () => null, policy);
    expect(JSON.stringify(snapshot)).not.toContain('5555');
  });

  it('ignores events that carry no value', () => {
    const snapshot = { type: 2, data: { node: { id: 1 } } };
    expect(() => scrubEvent(snapshot, () => null, policy)).not.toThrow();
    const mouse = { type: 3, data: { source: 2, id: 4, x: 1, y: 2 } };
    scrubEvent(mouse, () => null, policy);
    expect(mouse.data.x).toBe(1);
  });
});
