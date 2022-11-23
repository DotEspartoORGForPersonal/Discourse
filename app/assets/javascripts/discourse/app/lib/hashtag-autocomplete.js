import { findRawTemplate } from "discourse-common/lib/raw-templates";
import discourseLater from "discourse-common/lib/later";
import { INPUT_DELAY, isTesting } from "discourse-common/config/environment";
import { cancel } from "@ember/runloop";
import { CANCELLED_STATUS } from "discourse/lib/autocomplete";
import { ajax } from "discourse/lib/ajax";
import discourseDebounce from "discourse-common/lib/debounce";
import {
  caretPosition,
  caretRowCol,
  inCodeBlock,
} from "discourse/lib/utilities";
import { search as searchCategoryTag } from "discourse/lib/category-tag-search";

/**
 * Sets up a textarea using the jQuery autocomplete plugin, specifically
 * to match on the hashtag (#) character for autocompletion of categories,
 * tags, and other resource data types.
 *
 * @param {Array} contextualHashtagConfiguration - The hashtag datasource types in priority order
 *   that should be used when searching for or looking up hashtags from the server, determines
 *   the order of search results and the priority for looking up conflicting hashtags. See also
 *   Site.hashtag_configurations.
 * @param {$Element} $textarea - jQuery element to use for the autocompletion
 *   plugin to attach to, this is what will watch for the # matcher when the user is typing.
 * @param {Hash} siteSettings - The clientside site settings.
 * @param {Function} afterComplete - Called with the selected autocomplete option once it is selected.
 **/
export function setupHashtagAutocomplete(
  contextualHashtagConfiguration,
  $textArea,
  siteSettings,
  afterComplete
) {
  if (siteSettings.enable_experimental_hashtag_autocomplete) {
    _setupExperimental(
      contextualHashtagConfiguration,
      $textArea,
      siteSettings,
      afterComplete
    );
  } else {
    _setup($textArea, siteSettings, afterComplete);
  }
}

export function hashtagTriggerRule(textarea, opts) {
  const result = caretRowCol(textarea);
  const row = result.rowNum;
  let col = result.colNum;
  let line = textarea.value.split("\n")[row - 1];

  if (opts && opts.backSpace) {
    col = col - 1;
    line = line.slice(0, line.length - 1);

    // Don't trigger autocomplete when backspacing into a `#category |` => `#category|`
    if (/^#{1}\w+/.test(line)) {
      return false;
    }
  }

  // Don't trigger autocomplete when ATX-style headers are used
  if (col < 6 && line.slice(0, col) === "#".repeat(col)) {
    return false;
  }

  if (inCodeBlock(textarea.value, caretPosition(textarea))) {
    return false;
  }

  return true;
}

const checkedHashtags = new Set();
let seenHashtags = {};

// NOTE: For future maintainers, the hashtag lookup here does not take
// into account mixed contexts -- for instance, a chat quote inside a post
// or a post quote inside a chat message, so this may
// not provide an accurate priority lookup for hashtags without a ::type suffix in those
// cases.
export function fetchUnseenHashtagsInContext(
  contextualHashtagConfiguration,
  slugs
) {
  return ajax("/hashtags", {
    data: { slugs, order: contextualHashtagConfiguration },
  }).then((response) => {
    Object.keys(response).forEach((type) => {
      seenHashtags[type] = seenHashtags[type] || {};
      response[type].forEach((item) => {
        seenHashtags[type][item.ref] = seenHashtags[type][item.ref] || item;
      });
    });
    slugs.forEach(checkedHashtags.add, checkedHashtags);
  });
}

export function linkSeenHashtagsInContext(
  contextualHashtagConfiguration,
  elem
) {
  const hashtagSpans = [...(elem?.querySelectorAll("span.hashtag-raw") || [])];
  if (hashtagSpans.length === 0) {
    return [];
  }
  const slugs = [
    ...hashtagSpans.map((span) => span.innerText.replace("#", "")),
  ];

  hashtagSpans.forEach((hashtagSpan, index) => {
    _findAndReplaceSeenHashtagPlaceholder(
      slugs[index],
      contextualHashtagConfiguration,
      hashtagSpan
    );
  });

  return slugs
    .map((slug) => slug.toLowerCase())
    .uniq()
    .filter((slug) => !checkedHashtags.has(slug));
}

function _setupExperimental(
  contextualHashtagConfiguration,
  $textArea,
  siteSettings,
  afterComplete
) {
  $textArea.autocomplete({
    template: findRawTemplate("hashtag-autocomplete"),
    key: "#",
    afterComplete,
    treatAsTextarea: $textArea[0].tagName === "INPUT",
    transformComplete: (obj) => obj.ref,
    dataSource: (term) => {
      if (term.match(/\s/)) {
        return null;
      }
      return _searchGeneric(term, siteSettings, contextualHashtagConfiguration);
    },
    triggerRule: (textarea, opts) => hashtagTriggerRule(textarea, opts),
  });
}

function _setup($textArea, siteSettings, afterComplete) {
  $textArea.autocomplete({
    template: findRawTemplate("category-tag-autocomplete"),
    key: "#",
    afterComplete,
    transformComplete: (obj) => obj.text,
    dataSource: (term) => {
      if (term.match(/\s/)) {
        return null;
      }
      return searchCategoryTag(term, siteSettings);
    },
    triggerRule: (textarea, opts) => hashtagTriggerRule(textarea, opts),
  });
}

let searchCache = {};
let searchCacheTime;
let currentSearch;

function _updateSearchCache(term, results) {
  searchCache[term] = results;
  searchCacheTime = new Date();
  return results;
}

function _searchGeneric(term, siteSettings, contextualHashtagConfiguration) {
  if (currentSearch) {
    currentSearch.abort();
    currentSearch = null;
  }
  if (new Date() - searchCacheTime > 30000) {
    searchCache = {};
  }
  const cached = searchCache[term];
  if (cached) {
    return cached;
  }

  return new Promise((resolve) => {
    let timeoutPromise = isTesting()
      ? null
      : discourseLater(() => {
          resolve(CANCELLED_STATUS);
        }, 5000);

    if (term === "") {
      return resolve(CANCELLED_STATUS);
    }

    const debouncedSearch = (q, ctx, resultFunc) => {
      discourseDebounce(this, _searchRequest, q, ctx, resultFunc, INPUT_DELAY);
    };

    debouncedSearch(term, contextualHashtagConfiguration, (result) => {
      cancel(timeoutPromise);
      resolve(_updateSearchCache(term, result));
    });
  });
}

function _searchRequest(term, contextualHashtagConfiguration, resultFunc) {
  currentSearch = ajax("/hashtags/search.json", {
    data: { term, order: contextualHashtagConfiguration },
  });
  currentSearch
    .then((r) => {
      resultFunc(r.results || CANCELLED_STATUS);
    })
    .finally(() => {
      currentSearch = null;
    });
  return currentSearch;
}

function _findAndReplaceSeenHashtagPlaceholder(
  slug,
  contextualHashtagConfiguration,
  hashtagSpan
) {
  contextualHashtagConfiguration.forEach((type) => {
    // remove type suffixes
    const typePostfix = `::${type}`;
    if (slug.endsWith(typePostfix)) {
      slug = slug.slice(0, slug.length - typePostfix.length);
    }

    // replace raw span for the hashtag with a cooked one
    const matchingSeenHashtag = seenHashtags[type]?.[slug];
    if (matchingSeenHashtag) {
      // NOTE: When changing the HTML structure here, you must also change
      // it in the hashtag-autocomplete markdown rule, and vice-versa.
      const link = document.createElement("a");
      link.classList.add("hashtag-cooked");
      link.href = matchingSeenHashtag.relative_url;
      link.dataset.type = type;
      link.dataset.slug = matchingSeenHashtag.slug;
      link.innerHTML = `<svg class="fa d-icon d-icon-${matchingSeenHashtag.icon} svg-icon svg-node"><use href="#${matchingSeenHashtag.icon}"></use></svg><span>${matchingSeenHashtag.text}</span>`;
      hashtagSpan.replaceWith(link);
    }
  });
}
