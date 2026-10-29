package herdrapi

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// variant is implemented by every tagged-union variant.
type variant interface {
	variantTag() string
}

// UnknownVariant is a tagged-union member whose tag the pinned schema does
// not list, as a newer herdr may send. Raw is the whole object, tag
// included, and is written back unchanged.
type UnknownVariant struct {
	Tag string
	Raw json.RawMessage
}

func (u UnknownVariant) variantTag() string { return u.Tag }

// marshalVariant writes v's fields with its tag under key; a union holding
// no variant is null. An UnknownVariant, by value or by pointer, is written
// back as its raw JSON.
func marshalVariant(key string, v variant) ([]byte, error) {
	if v == nil {
		return []byte("null"), nil
	}
	if p, ok := v.(*UnknownVariant); ok {
		if p == nil {
			return nil, fmt.Errorf("nil *UnknownVariant in a %q union", key)
		}
		v = *p
	}
	if u, ok := v.(UnknownVariant); ok {
		if len(u.Raw) == 0 {
			return nil, fmt.Errorf("unknown %q variant has no raw JSON", u.Tag)
		}
		return u.Raw, nil
	}
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(body) < 2 || body[0] != '{' {
		return nil, fmt.Errorf("variant %q is not a JSON object", v.variantTag())
	}
	k, _ := json.Marshal(key)
	tag, _ := json.Marshal(v.variantTag())
	out := make([]byte, 0, len(body)+len(k)+len(tag)+2)
	out = append(out, '{')
	out = append(out, k...)
	out = append(out, ':')
	out = append(out, tag...)
	if rest := body[1:]; rest[0] != '}' {
		out = append(out, ',')
		out = append(out, rest...)
	} else {
		out = append(out, '}')
	}
	return out, nil
}

// variantTagOf reads the string under key in a union's JSON object; null
// is reported, not an error, so an optional union decodes as empty.
func variantTagOf(b []byte, key string) (tag string, null bool, err error) {
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return "", true, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return "", false, err
	}
	raw, ok := fields[key]
	if !ok {
		return "", false, fmt.Errorf("no %q tag", key)
	}
	if err := json.Unmarshal(raw, &tag); err != nil {
		return "", false, fmt.Errorf("%q tag: %w", key, err)
	}
	return tag, false, nil
}

// unmarshalParams decodes a request's params; absent params leave p zero.
func unmarshalParams(raw json.RawMessage, p any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, p)
}
