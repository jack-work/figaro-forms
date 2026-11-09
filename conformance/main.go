package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jack-work/figaro/api/form"
)

type applyCase struct {
	Base   json.RawMessage `json:"base"`
	Patch  form.Patch      `json:"patch"`
	Result json.RawMessage `json:"result"`
}

type inverseCase struct {
	Patch   form.Patch `json:"patch"`
	Inverse form.Patch `json:"inverse"`
}

type mergeCase struct {
	Base   json.RawMessage `json:"base"`
	P      form.Patch      `json:"p"`
	Q      form.Patch      `json:"q"`
	Merged *form.Patch     `json:"merged"`
}

type identityCase struct {
	Patch    form.Patch `json:"patch"`
	Identity bool       `json:"identity"`
}

type gen struct{ r *rand.Rand }

var keys = []string{"a", "b", "c", "d", "x.y", "__proto__", "constructor", "ñ"}

func (g gen) key() string { return keys[g.r.IntN(len(keys))] }

func (g gen) scalar() any {
	switch g.r.IntN(6) {
	case 0:
		return nil
	case 1:
		return g.r.IntN(2) == 0
	case 2:
		return g.r.IntN(100)
	case 3:
		return float64(g.r.IntN(1000)) / 8
	case 4:
		return []any{g.r.IntN(3), "s"}
	}
	return "v" + strconv.Itoa(g.r.IntN(5))
}

func (g gen) list() []any {
	n := g.r.IntN(4)
	seen := map[string]bool{}
	out := []any{}
	for range n {
		k := "k" + strconv.Itoa(g.r.IntN(5))
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, map[string]any{"Key": k, "Value": g.value(1)})
	}
	return out
}

func (g gen) value(depth int) any {
	if depth <= 0 {
		return g.scalar()
	}
	switch g.r.IntN(5) {
	case 0, 1:
		return g.object(depth - 1)
	case 2:
		return g.list()
	}
	return g.scalar()
}

func (g gen) object(depth int) map[string]any {
	out := map[string]any{}
	for range g.r.IntN(4) {
		out[g.key()] = g.value(depth)
	}
	return out
}

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func val(v any) form.Value { return form.NewValue(raw(v)) }

func (g gen) patch(depth int) form.Patch {
	switch g.r.IntN(6) {
	case 0:
		return form.Patch{Scalar: &form.ScalarPatch{Before: val(g.scalar()), After: val(g.value(depth))}}
	case 1:
		return form.Patch{List: g.listPatch(depth)}
	case 2:
		return form.Patch{}
	}
	return form.Patch{Object: g.objectPatch(depth)}
}

func (g gen) objectPatch(depth int) *form.ObjectPatch {
	o := &form.ObjectPatch{}
	for range g.r.IntN(4) {
		k := g.key()
		switch g.r.IntN(3) {
		case 0:
			if o.Set == nil {
				o.Set = map[string]form.Value{}
			}
			o.Set[k] = val(g.value(depth))
		case 1:
			if o.Delete == nil {
				o.Delete = map[string]form.Value{}
			}
			o.Delete[k] = val(g.scalar())
		default:
			if depth <= 0 {
				continue
			}
			if o.Update == nil {
				o.Update = map[string]form.Patch{}
			}
			o.Update[k] = g.patch(depth - 1)
			if g.r.IntN(4) == 0 {
				if o.New == nil {
					o.New = map[string]bool{}
				}
				o.New[k] = true
			}
		}
	}
	return o
}

func (g gen) listPatch(depth int) *form.ListPatch {
	l := &form.ListPatch{}
	for range g.r.IntN(3) {
		k := "k" + strconv.Itoa(g.r.IntN(5))
		switch g.r.IntN(3) {
		case 0:
			l.Create = append(l.Create, form.KeyedValue{Key: k, Value: val(g.scalar())})
		case 1:
			l.Delete = append(l.Delete, form.KeyedValue{Key: k, Value: val(g.scalar())})
		default:
			if depth > 0 {
				if l.Update == nil {
					l.Update = map[string]form.Patch{}
				}
				l.Update[k] = g.patch(depth - 1)
			}
		}
	}
	if g.r.IntN(3) == 0 {
		decl := []string{"k" + strconv.Itoa(g.r.IntN(5)), "k" + strconv.Itoa(g.r.IntN(5))}
		l.Order = &form.Order{Declared: decl, Moved: []int{0}}
		if g.r.IntN(2) == 0 {
			l.Order.Prior = []string{decl[1], decl[0]}
			l.Order.PriorMoved = []int{1}
		}
	}
	return l
}

func snapshotOf(v map[string]any) form.Snapshot {
	var s form.Snapshot
	if err := json.Unmarshal(raw(v), &s); err != nil {
		panic(err)
	}
	return s
}

func rootApply(g gen, n int) []applyCase {
	var out []applyCase
	for range n {
		base := g.object(2)
		s := snapshotOf(base)
		var p form.Patch
		if g.r.IntN(2) == 0 {
			p = snapshotOf(g.object(2)).Diff(s)
		} else {
			p = g.patch(3)
		}
		out = append(out, applyCase{Base: raw(s), Patch: p, Result: raw(s.Apply(p))})
	}
	return out
}

func valueApply(g gen, n int) []applyCase {
	var out []applyCase
	for range n {
		base := g.value(2)
		var p form.Patch
		if g.r.IntN(2) == 0 {
			p = form.Diff(val(base), val(g.value(2)))
		} else {
			p = g.patch(3)
		}
		next, err := p.Apply(val(base))
		if err != nil {
			continue
		}
		out = append(out, applyCase{Base: raw(base), Patch: p, Result: next.Raw()})
	}
	return out
}

func inverses(g gen, n int) []inverseCase {
	var out []inverseCase
	for range n {
		var p form.Patch
		if g.r.IntN(2) == 0 {
			p = snapshotOf(g.object(2)).Diff(snapshotOf(g.object(2)))
		} else {
			p = g.patch(3)
		}
		out = append(out, inverseCase{Patch: p, Inverse: p.Inverse()})
	}
	return out
}

func merges(g gen, n int) []mergeCase {
	var out []mergeCase
	for range n {
		base := g.object(2)
		a := snapshotOf(base)
		var p, q form.Patch
		if g.r.IntN(2) == 0 {
			b := snapshotOf(g.object(2))
			p = b.Diff(a)
			q = snapshotOf(g.object(2)).Diff(b)
		} else {
			p, q = g.patch(3), g.patch(3)
		}
		c := mergeCase{Base: raw(a), P: p, Q: q}
		if m, ok := form.TryMerge(p, q); ok {
			c.Merged = &m
		}
		out = append(out, c)
	}
	return out
}

func identities(g gen, n int) []identityCase {
	var out []identityCase
	for range n {
		p := g.patch(3)
		out = append(out, identityCase{Patch: p, Identity: p.IsIdentity()})
	}
	return out
}

type keyDoc struct {
	Key   string `json:"key"`
	Short string `json:"short"`
	Mode  string `json:"mode"`
}

func docs(in []form.KeyDoc) []keyDoc {
	modes := map[form.KeyMode]string{
		form.KeyUserSettable:     "user",
		form.KeySystemManaged:    "system",
		form.KeyEphemeralPerTurn: "per-turn",
	}
	out := make([]keyDoc, 0, len(in))
	for _, d := range in {
		out = append(out, keyDoc{Key: d.Key, Short: d.Short, Mode: modes[d.Mode]})
	}
	return out
}

func writeKeys(path string) {
	intrinsics := map[string][]keyDoc{}
	for _, name := range form.IntrinsicNames() {
		intrinsics[name] = docs(form.IntrinsicKeys(name))
	}
	known, err := json.MarshalIndent(docs(form.WellKnownKeys()), "", "  ")
	if err != nil {
		panic(err)
	}
	intr, err := json.MarshalIndent(intrinsics, "", "  ")
	if err != nil {
		panic(err)
	}
	src := "import type { KeyDoc } from \"./keys.js\";\n\n" +
		"export const wellKnownKeys: readonly KeyDoc[] = " + string(known) + ";\n\n" +
		"export const intrinsicKeys: { readonly [name: string]: readonly KeyDoc[] } = " + string(intr) + ";\n"
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		panic(err)
	}
}

func write(dir, name string, v any) {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), append(b, '\n'), 0o644); err != nil {
		panic(err)
	}
}

func main() {
	dir := flag.String("out", "../packages/figaro-forms/test/vectors", "output directory")
	seed := flag.Uint64("seed", 20261108, "generator seed")
	n := flag.Int("n", 400, "cases per file")
	keysOut := flag.String("keys", "../packages/figaro-forms/src/semantics/known-keys.gen.ts", "generated key catalog")
	flag.Parse()
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		panic(err)
	}
	g := gen{r: rand.New(rand.NewPCG(*seed, *seed^0x9e3779b97f4a7c15))}
	write(*dir, "apply-root.json", rootApply(g, *n))
	write(*dir, "apply-value.json", valueApply(g, *n))
	write(*dir, "inverse.json", inverses(g, *n))
	write(*dir, "trymerge.json", merges(g, *n))
	write(*dir, "identity.json", identities(g, *n))
	writeKeys(*keysOut)
	fmt.Fprintf(os.Stderr, "wrote %d cases per file to %s\n", *n, *dir)
}
