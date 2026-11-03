import type { ClientModule } from 'claude-code'

/** What the footer hook hands the tag: the dot and the label, already decided. */
export type TagProps = { glyph: string; color: string | null; label: string; isDim: boolean; epoch: number }

type TagState = { epoch: number }

/**
 * The footer tag's own region: the dot and the label, a left click switching CLM on and off,
 * a right click opening the menu; with the focus, Enter switches and "m" opens the menu.
 * It posts "mounted" for each load of the hooks module (its epoch), so the module knows this
 * surface draws Clients even after a hot reload kept the instance.
 */
const Tag: ClientModule<TagProps, TagState> = (props, surface) => {
  const isFirstDraw = surface.state === undefined

  if (surface.state?.epoch !== props.epoch) {
    surface.setState({ epoch: props.epoch })
    surface.post({ type: 'mounted' })
  }

  if (isFirstDraw) {
    surface.onPointer(event => {
      if (event.type !== 'up') return
      if (event.button === 'right') surface.post({ type: 'menu' })
      else if (event.button === 'left') surface.post({ type: 'toggle' })
    })
    surface.onKey(event => {
      if (event.key === 'return' || event.key === ' ') surface.post({ type: 'toggle' })
      else if (event.key === 'm') surface.post({ type: 'menu' })
    })
  }

  const { Box, Text } = surface.elements

  return (
    <Box flexDirection="row">
      {props.color === null ? (
        <Text dimColor>{props.glyph} </Text>
      ) : (
        <Text color={props.color} bold>
          {props.glyph}{' '}
        </Text>
      )}
      <Text dimColor={props.isDim}>{props.label}</Text>
    </Box>
  )
}

export default Tag
