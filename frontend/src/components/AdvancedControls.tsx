import type { LayoutOptions } from '../types'

interface AdvancedControlsProps {
  options: LayoutOptions
  onChange: (options: LayoutOptions) => void
  isComputing: boolean
  contigThickness: number
  onContigThicknessChange: (thickness: number) => void
  connectorThickness: number
  onConnectorThicknessChange: (thickness: number) => void
  labelLengthThreshold: number
  onLabelLengthThresholdChange: (threshold: number) => void
}

// Fine-tuning sliders (the "Advanced" tab). The layout ones need a Redraw;
// thickness and label settings apply to the current drawing immediately.
export function AdvancedControls({
  options,
  onChange,
  isComputing,
  contigThickness,
  onContigThicknessChange,
  connectorThickness,
  onConnectorThicknessChange,
  labelLengthThreshold,
  onLabelLengthThresholdChange,
}: AdvancedControlsProps) {
  return (
    <div className="settings-tab-content">
      <div className="settings-grid">
        <div className="control-group">
          <label>
            <strong>Quality Level:</strong>
            <span className="control-value">{options.quality}</span>
          </label>
          <input
            type="range"
            min="0"
            max="4"
            value={options.quality}
            onChange={e =>
              onChange({ ...options, quality: parseInt(e.target.value) })
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Higher = better layout, slower computation. Applies on the next
            Redraw.
          </div>
        </div>

        <div className="control-group">
          <label>
            <strong>Edge Length:</strong>
            <span className="control-value">
              {options.edgeLength.toFixed(0)}
            </span>
          </label>
          <input
            type="range"
            min="0.5"
            max="20"
            step="0.5"
            value={options.edgeLength}
            onChange={e =>
              onChange({
                ...options,
                edgeLength: parseFloat(e.target.value),
              })
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Distance between connected contigs (scales with node length).
            Applies on the next Redraw.
          </div>
        </div>

        <div className="control-group">
          <label>
            <strong>Component Separation:</strong>
            <span className="control-value">
              {options.componentSeparation.toFixed(1)}
            </span>
          </label>
          <input
            type="range"
            min="5"
            max="50"
            step="5"
            value={options.componentSeparation}
            onChange={e =>
              onChange({
                ...options,
                componentSeparation: parseFloat(e.target.value),
              })
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Space between disconnected components. Applies on the next Redraw.
          </div>
        </div>

        <div className="control-group">
          <label>
            <strong>Node Length Per Megabase:</strong>
            <span className="control-value">
              {options.nodeLengthPerMegabase.toFixed(0)}
            </span>
          </label>
          <input
            type="range"
            min="500"
            max="5000"
            step="500"
            value={options.nodeLengthPerMegabase}
            onChange={e =>
              onChange({
                ...options,
                nodeLengthPerMegabase: parseFloat(e.target.value),
              })
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Controls visual scale based on sequence length. Applies on the
            next Redraw.
          </div>
        </div>

        <div className="control-group">
          <label>
            <strong>Contig Thickness:</strong>
            <span className="control-value">
              {contigThickness.toFixed(1)}px
            </span>
          </label>
          <input
            type="range"
            min="1"
            max="10"
            step="0.5"
            value={contigThickness}
            onChange={e => onContigThicknessChange(parseFloat(e.target.value))}
            disabled={isComputing}
          />
          <div className="control-hint">Thickness of contig lines</div>
        </div>

        <div className="control-group">
          <label>
            <strong>Connector Thickness:</strong>
            <span className="control-value">
              {connectorThickness.toFixed(1)}px
            </span>
          </label>
          <input
            type="range"
            min="1"
            max="10"
            step="0.5"
            value={connectorThickness}
            onChange={e =>
              onConnectorThicknessChange(parseFloat(e.target.value))
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Thickness of connector lines (edges)
          </div>
        </div>

        <div className="control-group">
          <label>
            <strong>Label Length Threshold:</strong>
            <span className="control-value">
              {labelLengthThreshold.toLocaleString()} bp
            </span>
          </label>
          <input
            type="range"
            min="0"
            max="100000"
            step="1000"
            value={labelLengthThreshold}
            onChange={e =>
              onLabelLengthThresholdChange(parseFloat(e.target.value))
            }
            disabled={isComputing}
          />
          <div className="control-hint">
            Only show labels on contigs longer than this
          </div>
        </div>
      </div>
    </div>
  )
}
