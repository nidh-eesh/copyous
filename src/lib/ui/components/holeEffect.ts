import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';

import { registerClass } from '../../common/gjs.js';

// Based on https://gitlab.gnome.org/GNOME/mutter/-/blob/8b5c757bea75b7712bbe09c2018a8eb15b4d22cc/src/compositor/meta-background-content.c
const HOLE_SHADER_DECLARATIONS = `
	uniform sampler2D tex;
	uniform vec2 size;
	uniform vec4 hole_box;

	float circle_bounds(vec2 p, vec2 center, float radius) {
		vec2 delta = p - center;
		float dist_squared = dot(delta, delta);
		float dist = sqrt(dist_squared);

		float outer_radius = radius + 0.5;
		if (dist >= outer_radius)
			return 1.0;

		float inner_radius = radius - 0.5;
		if (dist <= inner_radius)
			return 0.0;

		return dist - inner_radius;
	}

	float rounded_rect_coverage(vec2 p, vec4 bounds, float radius) {
		if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
			return 1.0;

		vec2 center;

		float center_left = bounds.x + radius;
		float center_right = bounds.z - radius;

		if (p.x < center_left)
			center.x = center_left;
		else if (p.x > center_right)
			center.x = center_right;
		else
			return 0.0;

		center.y = bounds.y + radius;

		return circle_bounds(p, center, radius);
	}`;

const HOLE_SHADER_SOURCE = `
	vec2 uv = cogl_tex_coord_in[0].xy;
	vec2 p = size * cogl_tex_coord_in[0].xy;
	vec4 c = cogl_color_in * texture2D(tex, uv);

	if (hole_box.z <= 2.0 || hole_box.w <= 2.0) {
		cogl_color_out = c;
		return;
	}

	float radius = hole_box.w / 2.0;
	vec4 bounds = vec4(hole_box.x, hole_box.y, hole_box.x + hole_box.z, hole_box.y + hole_box.w);
	float alpha = rounded_rect_coverage(p, bounds, radius);
	cogl_color_out = vec4(c.rgb * alpha, min(alpha, c.a));`;

function getHoleBox(target: Clutter.Actor, actor: Clutter.Actor): number[] {
	const position = target.apply_relative_transform_to_point(actor, new Graphene.Point3D());
	const [width, height] = target.get_transformed_size();
	return [position.x - 1.5, position.y + 1, width + 2, height + 1];
}

const ClutterShaderEffect = (Clutter as unknown as { ShaderEffect?: typeof Clutter.OffscreenEffect }).ShaderEffect;

function createHoleEffectClass() {
	if (ClutterShaderEffect) {
		// Construct outside the native callback so an API error cannot return a null snippet to Cogl.
		const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, HOLE_SHADER_DECLARATIONS, null);
		snippet.set_replace(HOLE_SHADER_SOURCE);
		@registerClass()
		class HoleEffect51 extends ClutterShaderEffect {
			constructor(private target: Clutter.Actor) {
				super();

				target.connect('notify::allocation', () => {
					this.queue_repaint();
				});
			}

			vfunc_get_static_snippet(): Cogl.Snippet {
				return snippet;
			}

			override vfunc_paint_target(node: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
				const actor = this.get_actor();
				if (!actor) return;
				const shader = this as unknown as {
					set_uniform_float(name: string, nComponents: number, values: number[]): void;
				};
				shader.set_uniform_float('size', 2, actor.get_transformed_size());
				shader.set_uniform_float('hole_box', 4, getHoleBox(this.target, actor));

				super.vfunc_paint_target(node, paintContext);
			}
		}

		return HoleEffect51;
	}

	@registerClass()
	class HoleEffectLegacy extends Shell.GLSLEffect {
		private readonly _sizeLocation: number;
		private readonly _holeBoxLocation: number;

		constructor(private target: Clutter.Actor) {
			super();

			this._sizeLocation = this.get_uniform_location('size');
			this._holeBoxLocation = this.get_uniform_location('hole_box');

			target.connect('notify::allocation', () => this.queue_repaint());
		}

		override vfunc_paint_target(node: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
			const size = this.actor.get_transformed_size();
			this.set_uniform_float(this._sizeLocation, 2, size);
			this.set_uniform_float(this._holeBoxLocation, 4, getHoleBox(this.target, this.actor));
			super.vfunc_paint_target(node, paintContext);
		}

		override vfunc_build_pipeline(): void {
			this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, HOLE_SHADER_DECLARATIONS, HOLE_SHADER_SOURCE, true);
		}
	}

	return HoleEffectLegacy;
}

type HoleEffectConstructor = new (target: Clutter.Actor) => Clutter.Effect;
let HoleEffect: HoleEffectConstructor | null | undefined;

export function createHoleEffect(target: Clutter.Actor): Clutter.Effect | null {
	try {
		if (HoleEffect === undefined) HoleEffect = createHoleEffectClass();
		return HoleEffect ? new HoleEffect(target) : null;
	} catch (error) {
		HoleEffect = null;
		console.warn('Copyous content mask is unavailable; rendering card contents without the mask', error);
		return null;
	}
}
