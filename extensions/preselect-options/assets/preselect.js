async function startPreselectOptions() {
    const app = document.getElementById('preselect-options');

    if (!app || app.dataset.started === 'true') {
        return;
    }
    const shop = window.Shopify?.shop;
    if (!shop) return;

    app.dataset.started = 'true';

    // A variant link always takes priority over our initial selection.
    if (new URLSearchParams(window.location.search).has('variant')) {
        return;
    }

    // MainProduct excludes featured products, recommendations, and quick-add forms.
    const mainProduct = document.querySelector('main [id^="MainProduct-"]');
    const picker = mainProduct?.querySelector('variant-selects, variant-radios');
    if (!picker) {
        console.info('PreSelect: no supported Dawn variant picker was found.');
        return;
    }

    let shopperInteracted = false;
    function recordInteraction(event) {
        if (event.isTrusted) {
            shopperInteracted = true;
        }
    }
    const events = ['pointerdown', 'keydown', 'change', 'submit'];
    events.forEach(function (name) {
        mainProduct.addEventListener(name, recordInteraction, true);
    });

    const initialUrl = window.location.href;
    let timeout;
    const controller = new AbortController();
    const requestTimeout = setTimeout(function () { controller.abort(); }, 8000);
    try {
        const country = await detectPreselectCountry();
        if (shopperInteracted || window.location.href !== initialUrl) return;
        const url = new URL(app.dataset.endpoint);
        url.searchParams.set('shop', shop);
        url.searchParams.set('product_id', app.dataset.productId);
        url.searchParams.set('customer_logged_in', app.dataset.customerLoggedIn);
        if (country) url.searchParams.set('country', country);
        const headers = { Accept: 'application/json' };
        if (url.hostname.endsWith('.ngrok-free.dev') || url.hostname.endsWith('.ngrok-free.app')) {
            headers['ngrok-skip-browser-warning'] = 'true';
        }
        const response = await fetch(url, {
            credentials: 'omit',
            signal: controller.signal,
            headers: headers,
        });
        if (!response.ok) throw new Error('Selection request failed: ' + response.status);
        const result = await response.json();
        const variant = result.variant;
        if (!variant || shopperInteracted || window.location.href !== initialUrl) return;

        // Wait briefly for Dawn's native custom elements; never wait indefinitely.
        const definitions = [customElements.whenDefined(picker.localName)];
        if (mainProduct.localName === 'product-info') {
            definitions.push(customElements.whenDefined('product-info'));
        }
        const ready = await Promise.race([
            Promise.all(definitions).then(function () { return true; }),
            new Promise(function (resolve) {
                timeout = setTimeout(function () { resolve(false); }, 3000);
            }),
        ]);

        if (!ready || shopperInteracted || window.location.href !== initialUrl || !picker.isConnected) {
            return;
        }

        const form = mainProduct.querySelector('form[action*="/cart/add"]');
        const currentVariant = form?.querySelector('[name="id"]');
        if (!currentVariant || currentVariant.value === String(variant.id)) {
            return;
        }

        const groups = Array.from(picker.querySelectorAll('fieldset, .product-form__input--dropdown'));
        if (groups.length !== variant.options.length) {
            console.warn('PreSelect: the Dawn option groups do not match the selected variant.');
            return;
        }

        // Validate every option before changing any of the controls.
        const controls = groups.map(function (group, index) {
            const select = group.querySelector('select');
            if (select) {
                const option = Array.from(select.options).find(function (option) {
                    return option.value === variant.options[index];
                });
                return option && !option.disabled && !select.disabled ? { select: select, option: option } : null;
            }
            const radio = Array.from(group.querySelectorAll('input[type="radio"]')).find(function (input) {
                return input.value === variant.options[index];
            });
            return radio && !radio.disabled ? { radio: radio } : null;
        });
        if (controls.some(function (control) { return control === null; })) {
            console.warn('PreSelect: a selected variant option is missing or disabled.');
            return;
        }

        controls.forEach(function (control, index) {
            if (control.select) {
                control.select.value = control.option.value;
                // Recent Dawn versions read selected attributes, not only select.value.
                Array.from(control.select.options).forEach(function (option) {
                    option.toggleAttribute('selected', option === control.option);
                });
            } else {
                groups[index].querySelectorAll('input[type="radio"]').forEach(function (radio) {
                    radio.checked = radio === control.radio;
                });
            }
            if (typeof picker.updateSelectionMetadata === 'function') {
                picker.updateSelectionMetadata({ target: control.select || control.radio });
            }
        });

        // Keep the app selection out of the URL so a reload can load a newer assignment.
        keepPreselectProductUrl(mainProduct, picker, variant.id);

        // Let Dawn update its own price, media, availability, and cart variant ID.
        const lastControl = controls[controls.length - 1];
        (lastControl.select || lastControl.radio).dispatchEvent(new Event('change', { bubbles: true }));
        console.info('PreSelect: requested saved variant through the Dawn picker:', variant.id);
    } catch (error) {
        console.warn('PreSelect: the saved selection could not be applied.', error.message);
    } finally {
        clearTimeout(timeout);
        clearTimeout(requestTimeout);
        events.forEach(function (name) {
            mainProduct.removeEventListener(name, recordInteraction, true);
        });
    }
}

// Dawn updates the URL asynchronously in product-info, or synchronously in older pickers.
// Suppress only the initial app selection; later shopper selections keep Dawn's behavior.
function keepPreselectProductUrl(mainProduct, picker, variantId) {
    const owner = typeof mainProduct.updateURL === 'function' ? mainProduct : picker;
    if (typeof owner.updateURL !== 'function') return;

    const updateUrl = owner.updateURL;
    const restoreTimeout = setTimeout(function () {
        if (owner.updateURL === initialUpdateUrl) owner.updateURL = updateUrl;
    }, 10000);

    function initialUpdateUrl(...args) {
        clearTimeout(restoreTimeout);
        owner.updateURL = updateUrl;
        const selectedId = args[1] ?? this.currentVariant?.id;
        if (String(selectedId) !== String(variantId)) {
            return updateUrl.apply(this, args);
        }

        const previous = this.dataset.updateUrl;
        this.dataset.updateUrl = 'false';
        try {
            return updateUrl.apply(this, args);
        } finally {
            if (previous === undefined) delete this.dataset.updateUrl;
            else this.dataset.updateUrl = previous;
        }
    }
    owner.updateURL = initialUpdateUrl;
}

async function detectPreselectCountry() {
    const cacheKey = 'preselect-country';
    try {
        const cached = JSON.parse(sessionStorage.getItem(cacheKey));
        if (cached && cached.expires > Date.now() && /^[A-Z]{2}$/.test(cached.code)) {
            return cached.code;
        }
    } catch (error) {
        // Country detection still works if browser storage is unavailable.
    }
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 1500);
    try {
        const root = window.Shopify?.routes?.root || '/';
        const response = await fetch(root + 'browsing_context_suggestions.json?country[enabled]=true&language[enabled]=false', {
            signal: controller.signal,
        });
        if (!response.ok) return null;
        const data = await response.json();
        const code = data.detected_values?.country?.handle?.toUpperCase();
        if (!code || !/^[A-Z]{2}$/.test(code)) return null;
        try {
            sessionStorage.setItem(cacheKey, JSON.stringify({ code: code, expires: Date.now() + 3600000 }));
        } catch (error) {
            // Storage is optional.
        }
        return code;
    } catch (error) {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPreselectOptions, { once: true });
} else {
    startPreselectOptions();
}
