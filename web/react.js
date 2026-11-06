// Pinned Preact 10.26.4 + official hooks; see vendor/LICENSE-preact.txt.
import * as Preact from './vendor/preact.mjs';
import * as hooks from './vendor/hooks.mjs';

// The shared panel uses React's onChange semantics for text inputs. Preact's
// native onChange fires on blur, so map text controls to the input event.
function createElement(type, props, ...children) {
  if (props?.onChange && (type === 'textarea' ||
      (type === 'input' && !['checkbox', 'radio', 'file'].includes(props.type)))) {
    const {onChange, ...rest} = props;
    props = {...rest, onInput: onChange};
  }
  return Preact.createElement(type, props, ...children);
}

export const React = {...Preact, ...hooks, createElement};
export const render = Preact.render;
